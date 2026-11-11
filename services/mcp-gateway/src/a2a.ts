// A2A JSON-RPC binding for one app (A2A specification 1.0, §9): `SendMessage` maps a message to one
// of the app's actions and answers with the run's output as a direct agent Message. The 0.3 name
// `message/send` is accepted too and answered in the 0.3 shape (`kind` discriminators, bare result).
// The gateway keeps no tasks, so every other operation is UnsupportedOperationError.
import type { ActionDef, AppSchema } from '@kelay/contracts';

export const A2A_VERSIONS = ['1.0', '0.3'] as const;

/** JSON-RPC and A2A error codes (specification §5.4, §9.5). */
export const A2A_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedOperation: -32004,
  versionNotSupported: -32009,
} as const;

type Dialect = 'v1' | 'legacy';

const SEND: Record<string, Dialect> = { SendMessage: 'v1', 'message/send': 'legacy' };

/** Operations of the protocol this gateway does not offer: it is stateless and does not stream. */
const UNSUPPORTED = new Set([
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
  'message/stream',
  'tasks/get',
  'tasks/cancel',
  'tasks/resubscribe',
]);

export type JsonRpcId = string | number | null;

export class A2aError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export function errorResponse(id: JsonRpcId, error: A2aError) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.reason ? { data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: error.reason, domain: 'kelay.app' }] } : {}),
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const requestId = (body: unknown): JsonRpcId => {
  const id = isObject(body) ? body.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
};

export interface SendRequest {
  dialect: Dialect;
  /** The action the message asks for, and the input for it. */
  action: ActionDef;
  input: Record<string, unknown>;
  contextId: string | undefined;
}

const actionNamed = (schema: AppSchema, name: string): ActionDef | undefined =>
  (schema.actions ?? []).find((a) => a.name === name || `action_${a.name}` === name);

/**
 * Reads a `SendMessage` request. Which action runs is decided, in order, by a data part
 * `{ action, input? }`, by `metadata.skillId` (the agent card's skill ids are `action_<name>`), and
 * otherwise by the app's default action: its first one that runs an agent graph. A data part without
 * `action` is the input itself. Text parts are not interpreted.
 */
export function readSendRequest(schema: AppSchema, body: unknown): SendRequest {
  if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    throw new A2aError(A2A_ERROR.invalidRequest, 'Not a JSON-RPC 2.0 request.');
  }
  const dialect = Object.hasOwn(SEND, body.method) ? SEND[body.method] : undefined;
  if (!dialect) {
    if (UNSUPPORTED.has(body.method)) {
      throw new A2aError(A2A_ERROR.unsupportedOperation, `${body.method} is not supported: this agent answers SendMessage directly and keeps no tasks.`);
    }
    throw new A2aError(A2A_ERROR.methodNotFound, `Method not found: ${body.method}`);
  }
  const params = body.params;
  const message = isObject(params) ? params.message : undefined;
  if (!isObject(message) || !Array.isArray(message.parts) || message.parts.length === 0) {
    throw new A2aError(A2A_ERROR.invalidParams, 'params.message must be a Message with at least one part.');
  }
  if (typeof message.messageId !== 'string' || message.messageId === '') throw new A2aError(A2A_ERROR.invalidParams, 'params.message.messageId is required.');
  const role = message.role;
  if (role !== 'ROLE_USER' && role !== 'user') throw new A2aError(A2A_ERROR.invalidParams, 'params.message.role must be ROLE_USER.');

  const data = message.parts.map((part) => (isObject(part) ? part.data : undefined)).find(isObject);
  const metadata = [message.metadata, isObject(params) ? params.metadata : undefined].find(isObject);
  const named = typeof data?.action === 'string' ? data.action : typeof metadata?.skillId === 'string' ? metadata.skillId : undefined;

  let action: ActionDef | undefined;
  if (named !== undefined) {
    action = actionNamed(schema, named);
    if (!action) throw new A2aError(A2A_ERROR.invalidParams, `This app has no action "${named}".`);
  } else {
    action = (schema.actions ?? []).find((a) => a.graph);
    if (!action) throw new A2aError(A2A_ERROR.unsupportedOperation, 'This app has no action that runs an agent graph.');
  }

  let input: unknown = {};
  if (data) input = typeof data.action === 'string' ? (data.input ?? {}) : data;
  if (!isObject(input)) throw new A2aError(A2A_ERROR.invalidParams, 'The action input must be a JSON object.');
  return { dialect, action, input, contextId: typeof message.contextId === 'string' ? message.contextId : undefined };
}

/** The agent's answer: the output as text when it is a string, as a data part otherwise. */
export function sendResponse(id: JsonRpcId, req: SendRequest, output: unknown, runId: string | undefined) {
  const base = {
    messageId: crypto.randomUUID(),
    contextId: req.contextId ?? crypto.randomUUID(),
    metadata: { action: req.action.name, ...(runId ? { runId } : {}) },
  };
  if (req.dialect === 'legacy') {
    const parts = typeof output === 'string' ? [{ kind: 'text', text: output }] : [{ kind: 'data', data: output ?? null }];
    return { jsonrpc: '2.0' as const, id, result: { kind: 'message', role: 'agent', parts, ...base } };
  }
  const parts = typeof output === 'string' ? [{ text: output, mediaType: 'text/plain' }] : [{ data: output ?? null, mediaType: 'application/json' }];
  return { jsonrpc: '2.0' as const, id, result: { message: { role: 'ROLE_AGENT', parts, ...base } } };
}
