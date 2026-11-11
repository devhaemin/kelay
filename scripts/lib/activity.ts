// Two weeks of activity for the seeded apps, so Monitoring, the Agent tab and the App Graph have
// something to show on a fresh stack: screen actions, tool calls from the two seeded assistants, and
// calls between connected apps. The records go through the Control API's ingest routes
// (POST /internal/v1/runs and /internal/v1/mcp-calls), in the shapes the services send.
import type { McpCallRecord } from '@kelay/contracts';
import { BOARD, CONSENTS, GRANTS, TEAM, type TeamKey } from './data.ts';

export const ACTIVITY_DAYS = 14;

/** Body item of `POST /internal/v1/runs`. */
export interface RunRecord {
  app: string;
  action: string;
  status: 'ok' | 'blocked' | 'error';
  userId: string;
  args?: string;
  ms: number;
  note?: string;
  costUsd?: number;
  at: string;
  caller?: { kind: 'user' | 'app'; id?: string };
}

export interface Activity {
  runs: RunRecord[];
  calls: McpCallRecord[];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The team works in Seoul: days and office hours are counted in UTC+9. */
const KST = 9 * HOUR;

/** mulberry32: the same seed gives the same activity, so two fresh stacks look alike. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Weighted<T> = readonly (readonly [T, number])[];

const SCREEN_ACTIONS: Weighted<string> = [
  ['tickets_list', 34],
  ['tickets_update', 24],
  ['tickets_get', 12],
  ['comments_create', 10],
  ['tickets_create', 8],
  ['comments_list', 7],
  ['projects_list', 5],
];

/** Who uses the board how much; the guest mostly reads. */
const SCREEN_USERS: Weighted<TeamKey> = [
  ['junho', 28],
  ['mina', 24],
  ['daniel', 22],
  ['seoyeon', 18],
  ['hyunwoo', 8],
];

const AGENT_TOOLS: Weighted<string> = [
  ['tickets_list', 40],
  ['tickets_get', 20],
  ['tickets_update', 18],
  ['comments_create', 12],
  ['action_summarize_overdue', 7],
  // Members may not delete tickets, so an assistant acting for one is refused.
  ['tickets_delete', 3],
];

const DOC_ACTIONS: Weighted<string> = [
  ['documents_get', 60],
  ['documents_search', 30],
  ['documents_list', 10],
];

const STATUSES = ['todo', 'doing', 'review', 'done'] as const;
/** What the fixture policy refuses a guest (contracts fixtures/ticket-board/policy.json). */
const GUEST_DENIED = new Set(['tickets_update', 'tickets_create']);

export function buildActivity(users: Record<TeamKey, string>, now: Date): Activity {
  const rand = random(20261111);
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: Weighted<T>): T => {
    let r = rand() * items.reduce((sum, [, w]) => sum + w, 0);
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  };
  const roleOf = (key: TeamKey) => TEAM.find((p) => p.key === key)!.role;
  const ticket = () => BOARD[between(0, BOARD.length - 1)]!;

  const argsFor = (action: string): string | undefined => {
    if (action === 'tickets_update') return JSON.stringify({ id: ticket().id, values: { status: STATUSES[between(0, 3)] } });
    if (action === 'tickets_get' || action === 'tickets_delete') return JSON.stringify({ id: ticket().id });
    if (action === 'tickets_create') return JSON.stringify({ values: { title: 'Follow up with the customer', status: 'todo' } });
    if (action === 'comments_create') return JSON.stringify({ values: { ticket_id: ticket().id, body: 'Updated the draft, please take a look.' } });
    if (action === 'comments_list') return JSON.stringify({ where: { ticket_id: ticket().id } });
    if (action === 'tickets_list') return rand() < 0.5 ? JSON.stringify({ where: { status: STATUSES[between(0, 3)] } }) : '{}';
    return undefined;
  };

  const runs: RunRecord[] = [];
  const calls: McpCallRecord[] = [];
  const today = Math.floor((now.getTime() + KST) / DAY) * DAY - KST;

  // Monitoring charts UTC days, and a Seoul day starts nine hours before the UTC day of the same date,
  // so one more Seoul day is needed to reach the oldest of the chart's 14 buckets.
  for (let d = ACTIVITY_DAYS; d >= 0; d--) {
    const midnight = today - d * DAY;
    const weekday = new Date(midnight + KST).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    /** A moment in that day's office hours, or null when it has not happened yet. */
    const moment = (): string | null => {
      const at = midnight + 9 * HOUR + Math.floor(rand() * 10 * HOUR);
      return at <= now.getTime() ? new Date(at).toISOString() : null;
    };

    for (let i = between(weekend ? 8 : 70, weekend ? 20 : 110); i > 0; i--) {
      const at = moment();
      const who = pick(SCREEN_USERS);
      const action = pick(SCREEN_ACTIONS);
      const args = argsFor(action);
      if (!at) continue;
      const blocked = roleOf(who) === 'guest' && GUEST_DENIED.has(action);
      runs.push({
        app: 'ticket-board',
        action,
        status: blocked ? 'blocked' : 'ok',
        userId: users[who],
        ...(args ? { args } : {}),
        ms: between(18, 160),
        ...(blocked ? { note: `guest may not ${action === 'tickets_create' ? 'create' : 'update'} tickets` } : {}),
        at,
      });
    }

    // The app's own agent action, the only thing here that spends model budget.
    for (let i = between(weekend ? 0 : 2, weekend ? 1 : 5); i > 0; i--) {
      const at = moment();
      const who = pick(SCREEN_USERS);
      const costUsd = between(12, 48) / 1000;
      if (!at || roleOf(who) === 'guest') continue;
      runs.push({ app: 'ticket-board', action: 'summarize_overdue', status: 'ok', userId: users[who], ms: between(2400, 6800), costUsd, at });
    }

    for (const consent of CONSENTS) {
      for (let i = between(weekend ? 0 : 8, weekend ? 3 : 18); i > 0; i--) {
        const at = moment();
        const tool = pick(AGENT_TOOLS);
        const args = argsFor(tool);
        if (!at) continue;
        const denied = tool === 'tickets_delete';
        calls.push({
          type: 'mcp_call',
          app: consent.app,
          sub: users[consent.user],
          client: consent.clientId,
          tool,
          ms: tool.startsWith('action_') ? between(2400, 6800) : between(22, 190),
          ok: !denied,
          ...(denied ? { denied: true } : {}),
          args: args ?? '{}',
          at,
        });
      }
    }

    // Calls over the connected app-to-app links, about as many a day as the link's seeded total.
    for (const g of GRANTS) {
      if (!g.connected) continue;
      for (let i = weekend ? between(0, 4) : between(Math.round(g.calls * 0.7), Math.round(g.calls * 1.2)); i > 0; i--) {
        const at = moment();
        const who = pick(SCREEN_USERS);
        const action = pick(DOC_ACTIONS);
        if (!at) continue;
        runs.push({ app: g.toApp, action, status: 'ok', userId: users[who], ms: between(30, 220), caller: { kind: 'app', id: g.fromApp }, at });
      }
    }

    for (let i = between(weekend ? 2 : 14, weekend ? 6 : 30); i > 0; i--) {
      const at = moment();
      const who = pick(SCREEN_USERS);
      const action = rand() < 0.7 ? 'pages_get' : 'pages_update';
      if (!at) continue;
      runs.push({ app: 'team-wiki', action, status: 'ok', userId: users[who], ms: between(20, 140), at });
    }
  }

  // FB-129: moving a ticket to Done failed for three people before v12 fixed it.
  for (const [who, hoursAgo] of [['daniel', 46], ['mina', 45.5], ['junho', 44.5]] as const) {
    runs.push({
      app: 'ticket-board',
      action: 'tickets_update',
      status: 'error',
      userId: users[who],
      args: JSON.stringify({ id: ticket().id, values: { status: 'done' } }),
      ms: between(140, 320),
      note: 'Moving a ticket to Done needs a resolution',
      at: new Date(now.getTime() - hoursAgo * HOUR).toISOString(),
    });
  }

  return { runs, calls };
}
