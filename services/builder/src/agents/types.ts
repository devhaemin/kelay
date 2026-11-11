import type { AgentInfo, TurnKind } from '../events.ts';

export interface AgentTurn {
  app: string;
  /** The workspace directory: the only place the agent may read or write. */
  dir: string;
  kind: TurnKind;
  prompt: string;
  /** What the builder was looking at when they wrote the message, e.g. "Screen · Board". */
  context?: string | null;
  /** The agent's own conversation id from the previous turn, when it keeps one. */
  sessionId?: string | null;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'step'; text: string }
  | { type: 'text'; text: string }
  | { type: 'file'; path: string; change: 'created' | 'modified' | 'deleted' };

export interface AgentResult {
  /** The closing message for the builder. */
  text: string;
  sessionId?: string | null;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Something that changes the files of a workspace to match a request. It never commits or deploys. */
export interface CodingAgent {
  readonly info: AgentInfo;
  run(turn: AgentTurn, emit: (event: AgentEvent) => void): Promise<AgentResult>;
}
