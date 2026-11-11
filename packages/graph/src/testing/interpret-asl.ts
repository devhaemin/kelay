// Test-only interpreter for the ASL subset compileToAsl emits. JSONata is evaluated with the jsonata
// library, so the compiled expressions run for real. Neither aws-local-stepfunctions nor Step Functions
// Local executes JSONata state machines with variables, which is why this exists.
import jsonata from 'jsonata';
import type { AslBranch, AslStateMachine, AslTask } from '../compile.ts';

export type LambdaHandler = (functionName: string, payload: unknown) => unknown;

export class AslFailure extends Error {
  readonly error: string;
  constructor(error: string, message: string) {
    super(message);
    this.name = 'AslFailure';
    this.error = error;
  }
}

interface Scope {
  vars: Record<string, unknown>;
  parent?: Scope;
}

const visible = (s: Scope): Record<string, unknown> => ({ ...(s.parent ? visible(s.parent) : {}), ...s.vars });

async function evaluate(template: unknown, bindings: Record<string, unknown>): Promise<unknown> {
  if (typeof template === 'string') {
    const m = /^\{%(.*)%\}$/s.exec(template);
    if (!m) return template;
    const value: unknown = await jsonata(m[1]!).evaluate(null, bindings);
    if (value === undefined) throw new AslFailure('States.QueryEvaluationError', `${template} evaluated to undefined`);
    return JSON.parse(JSON.stringify(value));
  }
  if (Array.isArray(template)) return Promise.all(template.map((t) => evaluate(t, bindings)));
  if (template !== null && typeof template === 'object') {
    const entries = await Promise.all(Object.entries(template).map(async ([k, v]) => [k, await evaluate(v, bindings)] as const));
    return Object.fromEntries(entries);
  }
  return template;
}

export async function interpretAsl(
  machine: AslStateMachine,
  executionInput: unknown,
  lambda: LambdaHandler,
  executionName = 'test-execution',
): Promise<unknown> {
  const execution = { Name: executionName, Input: executionInput };

  const task = async (s: AslTask, bind: (retryCount: number, result?: unknown) => Record<string, unknown>) => {
    const used = s.Retry.map(() => 0);
    for (let retryCount = 0; ; retryCount++) {
      try {
        const args = (await evaluate(s.Arguments, bind(retryCount))) as { FunctionName: string; Payload: unknown };
        const payload: unknown = await lambda(args.FunctionName, args.Payload);
        return await evaluate(s.Output, bind(retryCount, { Payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload)) }));
      } catch (e) {
        const error = e instanceof AslFailure ? e.error : e instanceof Error ? e.name : 'Error';
        const i = s.Retry.findIndex((r) => r.ErrorEquals.includes(error) || r.ErrorEquals.includes('States.ALL'));
        if (i < 0 || used[i]! >= s.Retry[i]!.MaxAttempts) throw e instanceof AslFailure ? e : new AslFailure(error, String(e));
        used[i]!++;
      }
    }
  };

  const run = async (m: AslBranch, input: unknown, scope: Scope): Promise<unknown> => {
    let name = m.StartAt;
    let data = input;
    for (;;) {
      const s = m.States[name];
      if (!s) throw new Error(`no state named ${name}`);
      const bind = (retryCount = 0, result?: unknown) => ({
        ...visible(scope),
        states: {
          input: data,
          context: { Execution: execution, State: { Name: name, RetryCount: retryCount } },
          ...(result === undefined ? {} : { result }),
        },
      });
      switch (s.Type) {
        case 'Succeed':
          return data;
        case 'Fail':
          throw new AslFailure(s.Error, s.Cause);
        case 'Choice': {
          let next = s.Default;
          for (const rule of s.Choices) {
            if ((await evaluate(rule.Condition, bind())) !== true) continue;
            if (rule.Assign) Object.assign(scope.vars, await evaluate(rule.Assign, bind()));
            next = rule.Next;
            break;
          }
          name = next;
          continue;
        }
        case 'Pass': {
          const b = bind();
          const output = s.Output === undefined ? data : await evaluate(s.Output, b);
          if (s.Assign) Object.assign(scope.vars, await evaluate(s.Assign, b));
          data = output;
          break;
        }
        case 'Parallel':
          data = await Promise.all(s.Branches.map((br) => run(br, data, { vars: {}, parent: scope })));
          break;
        case 'Task':
          data = await task(s, bind);
          break;
      }
      if (s.End) return data;
      name = s.Next!;
    }
  };

  return run(machine, executionInput, { vars: {} });
}
