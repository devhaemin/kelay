// GraphSpec → AWS Step Functions ASL (contract §10), using the JSONata query language.
import type { GraphNode, GraphSpec, NodeInvocation } from '@kelay/contracts';
import { retryPolicy } from './retry.ts';
import { validateGraph } from './validate.ts';

export type Template = string | number | boolean | null | Template[] | { [key: string]: Template };

export interface AslRetrier {
  ErrorEquals: string[];
  MaxAttempts: number;
  IntervalSeconds: number;
  BackoffRate: number;
}

type Transition = { Next: string; End?: never } | { End: true; Next?: never };

export type AslTask = {
  Type: 'Task';
  Resource: 'arn:aws:states:::lambda:invoke';
  Arguments: { FunctionName: string; Payload: Record<keyof NodeInvocation, Template> };
  Output: string;
  TimeoutSeconds?: number;
  Retry: AslRetrier[];
} & Transition;
export type AslPass = { Type: 'Pass'; Assign?: Record<string, Template>; Output?: Template } & Transition;
export type AslParallel = { Type: 'Parallel'; Branches: AslBranch[] } & Transition;
export interface AslChoiceRule {
  Condition: string;
  Assign?: Record<string, Template>;
  Next: string;
}
export interface AslChoice {
  Type: 'Choice';
  Choices: AslChoiceRule[];
  Default: string;
}
export interface AslSucceed {
  Type: 'Succeed';
}
export interface AslFail {
  Type: 'Fail';
  Error: string;
  Cause: string;
}
export type AslState = AslTask | AslPass | AslParallel | AslChoice | AslSucceed | AslFail;

export interface AslBranch {
  StartAt: string;
  States: Record<string, AslState>;
}
export interface AslStateMachine extends AslBranch {
  Comment: string;
  QueryLanguage: 'JSONata';
}

/** Input a compiled state machine expects when an execution starts. */
export interface GraphExecutionInput {
  input?: unknown;
  /** The user's Kelay ID token, handed to every node invocation. */
  userToken: string;
}

export interface CompileOptions {
  app: string;
  env: NodeInvocation['env'];
  /** One function for every node (it dispatches on `node`), or one per node. */
  functionArn: string | ((node: string, def: GraphNode) => string);
}

// Node names start with a lowercase letter, so these generated names never collide with them.
export const INIT_STATE = 'Init';
export const DONE_STATE = 'Done';
export const INVALID_REVIEW_STATE = 'Invalid review output';
export const fanOutStateName = (node: string): string => `Fan out from ${node}`;
export const reviewStateName = (node: string): string => `Check ${node}`;

export const INVALID_REVIEW_ERROR = 'Kelay.InvalidReviewOutput';

/** Lambda service-side failures AWS recommends retrying; they never reach node code. */
export const LAMBDA_TRANSIENT_RETRY: AslRetrier = {
  ErrorEquals: [
    'Lambda.ServiceException',
    'Lambda.AWSLambdaException',
    'Lambda.SdkClientException',
    'Lambda.TooManyRequestsException',
  ],
  MaxAttempts: 3,
  IntervalSeconds: 1,
  BackoffRate: 2,
};

const rejectsVar = (node: string): string => `rejects_${node}`;

/**
 * Compiles a graph to ASL. Semantics, mirrored by `runLocal`:
 * - each node is a `lambda:invoke` Task whose payload is a `NodeInvocation`; `attempt` starts at 1;
 * - a fan-out is a Parallel state, and the join node receives the branch outputs as an array in `next` order;
 * - a review node's output must hold a boolean `approved`. When it is false and that review has rejected
 *   fewer than `maxLoops` times, the run goes back to `onReject` with the review output as input and
 *   `loop` (the run's total rejections) grows by one. Otherwise the run continues to `next`, or ends
 *   with the review output.
 */
export function compileToAsl(spec: GraphSpec, opts: CompileOptions): AslStateMachine {
  const g = validateGraph(spec);
  const { functionArn } = opts;
  const arnFor = typeof functionArn === 'string' ? () => functionArn : functionArn;
  const branchNodes = new Set(Object.values(g.nodes).flatMap((n) => (Array.isArray(n.next) ? n.next : [])));
  const reviewNodes = Object.keys(g.nodes).filter((n) => g.nodes[n]!.review);

  const task = (name: string, node: GraphNode, transition: Transition): AslTask => {
    const policy = retryPolicy(node);
    return {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      Arguments: {
        FunctionName: arnFor(name, node),
        Payload: {
          runId: '{% $states.context.Execution.Name %}',
          app: opts.app,
          env: opts.env,
          graph: g.name,
          node: name,
          attempt: '{% $states.context.State.RetryCount + 1 %}',
          loop: '{% $loop %}',
          input: '{% $states.input %}',
          userToken: '{% $states.context.Execution.Input.userToken %}',
        },
      },
      Output: '{% $states.result.Payload %}',
      ...(node.timeoutSeconds !== undefined ? { TimeoutSeconds: node.timeoutSeconds } : {}),
      Retry: [
        LAMBDA_TRANSIENT_RETRY,
        ...(policy
          ? [
              {
                ErrorEquals: ['States.ALL'],
                MaxAttempts: policy.maxAttempts,
                IntervalSeconds: policy.intervalSeconds,
                BackoffRate: policy.backoffRate,
              },
            ]
          : []),
      ],
      ...transition,
    };
  };

  const follow = (name: string, node: GraphNode): string | undefined =>
    node.next === undefined ? undefined : typeof node.next === 'string' ? node.next : fanOutStateName(name);

  const states: Record<string, AslState> = {
    [INIT_STATE]: {
      Type: 'Pass',
      Assign: { loop: 0, ...Object.fromEntries(reviewNodes.map((n) => [rejectsVar(n), 0])) },
      Output: '{% $exists($states.input.input) ? $states.input.input : null %}',
      Next: g.start,
    },
  };
  let needsDone = false;

  for (const [name, node] of Object.entries(g.nodes)) {
    if (branchNodes.has(name)) continue;
    const then = follow(name, node);
    if (node.review) {
      const v = rejectsVar(name);
      states[name] = task(name, node, { Next: reviewStateName(name) });
      states[reviewStateName(name)] = {
        Type: 'Choice',
        Choices: [
          { Condition: "{% $not($type($states.input.approved) = 'boolean') %}", Next: INVALID_REVIEW_STATE },
          {
            Condition: `{% $states.input.approved = false and $${v} < ${node.review.maxLoops} %}`,
            Assign: { [v]: `{% $${v} + 1 %}`, loop: '{% $loop + 1 %}' },
            Next: node.review.onReject,
          },
        ],
        Default: then ?? DONE_STATE,
      };
      needsDone ||= then === undefined;
    } else {
      states[name] = task(name, node, then === undefined ? { End: true } : { Next: then });
    }
    if (Array.isArray(node.next)) {
      states[fanOutStateName(name)] = {
        Type: 'Parallel',
        Branches: node.next.map((b) => ({ StartAt: b, States: { [b]: task(b, g.nodes[b]!, { End: true }) } })),
        Next: g.nodes[node.next[0]!]!.next as string,
      };
    }
  }

  if (needsDone) states[DONE_STATE] = { Type: 'Succeed' };
  if (reviewNodes.length > 0) {
    states[INVALID_REVIEW_STATE] = {
      Type: 'Fail',
      Error: INVALID_REVIEW_ERROR,
      Cause: 'A review node must output an object with a boolean "approved" field.',
    };
  }

  return {
    Comment: `Kelay graph ${g.name} for ${opts.app} (${opts.env})`,
    QueryLanguage: 'JSONata',
    StartAt: INIT_STATE,
    States: states,
  };
}
