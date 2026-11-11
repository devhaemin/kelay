// What the Builder (services/builder) reports, and how the console shows it. Safe for client code:
// the browser gets these events from the console's own /api/builder routes, never from the Builder.
import type { ChatMessage, ChatPart } from './api/types';

export interface BuilderAgent {
  /** `scripted` is the demo agent that builds the Ticket Board without a model. */
  kind: 'claude' | 'scripted';
  model: string | null;
}

interface EventBase {
  id: number;
  at: string;
  app: string;
  turn: string;
}

export type BuilderEvent = EventBase &
  (
    | { type: 'turn.started'; kind: 'build' | 'message' | 'improvement'; prompt: string; context: string | null; agent: BuilderAgent }
    | { type: 'step'; key: string; text: string; status: 'running' | 'done' | 'failed' }
    | { type: 'assistant.text'; text: string }
    | { type: 'file'; path: string; change: 'created' | 'modified' | 'deleted' }
    | { type: 'commit'; commit: string; message: string; files: string[]; branch: string }
    | { type: 'validation'; ok: boolean; attempt: number; problems: { path: string; message: string }[] }
    | { type: 'deploy'; ok: boolean; env: 'dev'; version: string | null; versionId: string | null; error: string | null }
    | { type: 'preview'; url: string }
    | { type: 'turn.finished'; status: 'succeeded' | 'failed'; error: string | null }
  );

export interface BuilderWorkspace {
  app: string;
  state: 'working' | 'idle' | 'stopped';
  agent: BuilderAgent;
  previewUrl: string | null;
  version: string | null;
  lastEventId: number;
}

/** A workspace and its transcript so far, as the server hands them to a page. */
export interface BuilderSession {
  workspace: BuilderWorkspace;
  events: BuilderEvent[];
}

export const EVENT_TYPES = ['turn.started', 'step', 'assistant.text', 'file', 'commit', 'validation', 'deploy', 'preview', 'turn.finished'] as const;

export const agentLabel = (agent: BuilderAgent): string => (agent.kind === 'claude' ? `Claude${agent.model ? ` · ${agent.model}` : ''}` : 'Scripted demo agent');

/** Adds events to a transcript, in order and without repeats (a reconnect may replay some). */
export function mergeEvents(known: BuilderEvent[], more: BuilderEvent[]): BuilderEvent[] {
  const last = known.at(-1)?.id ?? 0;
  const fresh = more.filter((e) => e.id > last);
  return fresh.length === 0 ? known : [...known, ...fresh];
}

export interface TurnStep {
  key: string;
  text: string;
  status: 'running' | 'done' | 'failed';
}

export interface TurnView {
  id: string;
  kind: 'build' | 'message' | 'improvement';
  prompt: string;
  agent: BuilderAgent;
  steps: TurnStep[];
  /** What the agent said, in order. */
  texts: string[];
  /** Steps and texts in the order they happened, for the chat. */
  parts: ChatPart[];
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  previewUrl: string | null;
  version: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function turnsOf(events: BuilderEvent[]): TurnView[] {
  const turns = new Map<string, TurnView>();
  const order: { turn: string; kind: 'step' | 'text'; key: string }[] = [];
  for (const e of events) {
    if (e.type === 'turn.started') {
      turns.set(e.turn, { id: e.turn, kind: e.kind, prompt: e.prompt, agent: e.agent, steps: [], texts: [], parts: [], status: 'running', error: null, previewUrl: null, version: null, startedAt: e.at, finishedAt: null });
      continue;
    }
    const turn = turns.get(e.turn);
    if (!turn) continue;
    if (e.type === 'step') {
      const known = turn.steps.find((s) => s.key === e.key);
      if (known) known.status = e.status;
      else {
        turn.steps.push({ key: e.key, text: e.text, status: e.status });
        order.push({ turn: e.turn, kind: 'step', key: e.key });
      }
    } else if (e.type === 'assistant.text') {
      order.push({ turn: e.turn, kind: 'text', key: String(turn.texts.push(e.text) - 1) });
    } else if (e.type === 'preview') turn.previewUrl = e.url;
    else if (e.type === 'deploy' && e.ok) turn.version = e.version;
    else if (e.type === 'turn.finished') {
      turn.status = e.status;
      turn.error = e.error;
      turn.finishedAt = e.at;
    }
  }
  for (const o of order) {
    const turn = turns.get(o.turn)!;
    if (o.kind === 'text') turn.parts.push({ kind: 'text', text: turn.texts[Number(o.key)]! });
    else {
      const step = turn.steps.find((s) => s.key === o.key)!;
      // A step still "running" in a turn that ended was cut off; the turn's error says why.
      if (step.status === 'failed' || (step.status === 'running' && turn.status !== 'running')) turn.parts.push({ kind: 'text', text: `_Stopped at: ${step.text}_` });
      else turn.parts.push({ kind: 'step', text: step.text, done: step.status === 'done' });
    }
  }
  return [...turns.values()];
}

/** The Builder chat: each turn is the request and the agent's answer. */
export function threadFromEvents(events: BuilderEvent[]): ChatMessage[] {
  return turnsOf(events).flatMap((turn): ChatMessage[] => {
    const author = turn.agent.kind === 'scripted' ? 'Builder · scripted demo' : 'Builder';
    const parts = [...turn.parts];
    if (turn.status === 'failed') parts.push({ kind: 'text', text: turn.error ?? 'That didn’t work.' });
    else if (turn.status === 'running' && !parts.some((p) => p.kind === 'step' && !p.done)) parts.push({ kind: 'step', text: 'Working', done: false });
    const request: ChatMessage =
      turn.kind === 'improvement'
        ? { id: `${turn.id}-request`, role: 'agent', author: 'Self-Improvement Agent', parts: [{ kind: 'text', text: `Approved proposal: **${turn.prompt.split('\n')[0]}**` }] }
        : { id: `${turn.id}-request`, role: 'user', author: null, parts: [{ kind: 'text', text: turn.prompt }] };
    return [request, { id: `${turn.id}-reply`, role: 'agent', author, parts }];
  });
}
