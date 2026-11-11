// What a workspace reports while it works. The same records are the SSE stream of
// `GET /v1/workspaces/:app/events` and the transcript the console rebuilds the chat from.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AgentInfo {
  /** `scripted` builds the Ticket Board fixture without a model; the UI must say so. */
  kind: 'claude' | 'scripted';
  model: string | null;
}

export type TurnKind = 'build' | 'message' | 'improvement';

export interface Problem {
  path: string;
  message: string;
}

export type WorkspaceEventBody =
  | { type: 'turn.started'; kind: TurnKind; prompt: string; context: string | null; agent: AgentInfo }
  | { type: 'step'; key: string; text: string; status: 'running' | 'done' | 'failed' }
  | { type: 'assistant.text'; text: string }
  | { type: 'file'; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'commit'; commit: string; message: string; files: string[]; branch: string }
  | { type: 'validation'; ok: boolean; attempt: number; problems: Problem[] }
  | { type: 'build'; ok: boolean; attempt: number; error: string | null }
  | { type: 'deploy'; ok: boolean; env: 'dev'; version: string | null; versionId: string | null; error: string | null }
  | { type: 'preview'; url: string }
  | { type: 'turn.finished'; status: 'succeeded' | 'failed'; error: string | null };

export type WorkspaceEvent = WorkspaceEventBody & {
  /** Position in the workspace's log, from 1. SSE uses it as the event id, so a reconnect resumes after it. */
  id: number;
  at: string;
  app: string;
  turn: string;
};

type Listener = (event: WorkspaceEvent) => void;

/** Append-only log of one workspace. With a file it survives a restart of the service. */
export class EventLog {
  private readonly events: WorkspaceEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly app: string,
    private readonly file?: string,
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as WorkspaceEvent);
        } catch {
          // A line cut short by a crash; the events before it are still good.
        }
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  append(turn: string, body: WorkspaceEventBody): WorkspaceEvent {
    const event = { ...body, id: (this.events.at(-1)?.id ?? 0) + 1, at: new Date().toISOString(), app: this.app, turn } as WorkspaceEvent;
    this.events.push(event);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  since(id = 0): WorkspaceEvent[] {
    return this.events.filter((e) => e.id > id);
  }

  get last(): WorkspaceEvent | undefined {
    return this.events.at(-1);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
