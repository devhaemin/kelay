// The Builder without a model: it writes the Ticket Board app from the contracts fixture, whatever the
// prompt says, so the whole flow (workspace, commit, check, deploy, preview) runs without an API key.
import { existsSync } from 'node:fs';
import { appendFile, cp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentInfo } from '../events.ts';
import type { AgentEvent, AgentResult, AgentTurn, CodingAgent } from './types.ts';

const require = createRequire(import.meta.url);
const SCREENS = fileURLToPath(new URL('../../scripted/ticket-board', import.meta.url));
const fixture = async (name: string) => JSON.parse(await readFile(require.resolve(`@kelay/contracts/fixtures/ticket-board/${name}`), 'utf8'));

const literal = (value: unknown) => JSON.stringify(value, null, 2);

const schemaFile = (schema: unknown) => `// Written by the Builder. Roles, collections and actions of this app.
import { defineApp } from '@kelay/sdk';

export const app = defineApp(${literal(schema)});
`;

const policyFile = (policy: unknown) => `// Written by the Builder. Who may read, create, update and delete what.
import { definePolicy } from '@kelay/sdk';

export const policy = definePolicy(${literal(policy)});
`;

const graphsFile = (graphs: unknown[]) => `// Written by the Builder. Agent graphs that actions run.
import { defineGraph } from '@kelay/sdk';

export const graphs = [${graphs.map((g) => `defineGraph(${literal(g)})`).join(', ')}];
`;

const SCHEMA_LITERAL = /defineApp\((\{[\s\S]*\})\);\s*$/;

const UNSUPPORTED =
  'This Builder is running its scripted demo agent, because no model key is configured. It can’t make free-form changes. ' +
  'The one follow-up it knows is **adding a priority field to tickets**: ask for “priority” to see a change go through. ' +
  'Set `ANTHROPIC_API_KEY` to have Claude build from what you write.';

export class ScriptedAgent implements CodingAgent {
  readonly info: AgentInfo = { kind: 'scripted', model: null };

  async run(turn: AgentTurn, emit: (event: AgentEvent) => void): Promise<AgentResult> {
    const schemaPath = join(turn.dir, 'kelay/schema.ts');
    // Only a schema this agent wrote itself is plain JSON inside defineApp(); the starter's is not.
    let current: { collections: { name: string; fields: Record<string, unknown> }[] } | null = null;
    try {
      current = JSON.parse(SCHEMA_LITERAL.exec(await readFile(schemaPath, 'utf8'))?.[1] ?? '');
    } catch {
      current = null;
    }
    if (!current?.collections.some((c) => c.name === 'tickets')) return this.build(turn, emit);
    if (/priorit/i.test(turn.prompt)) return this.addPriority(schemaPath, current, emit);
    return { text: UNSUPPORTED };
  }

  private async build(turn: AgentTurn, emit: (event: AgentEvent) => void): Promise<AgentResult> {
    emit({ type: 'step', text: 'Understood the request' });
    const [schema, policy, graph] = await Promise.all([fixture('schema.json'), fixture('policy.json'), fixture('graph.overdue-summary.json')]);

    emit({ type: 'step', text: `Created data: ${schema.collections.map((c: { name: string }) => c.name).join(', ')}` });
    const write = async (path: string, content: string) => {
      const file = join(turn.dir, path);
      const change = existsSync(file) ? 'modified' : 'created';
      await writeFile(file, content);
      emit({ type: 'file', path, change });
    };
    await write('kelay/schema.ts', schemaFile({ ...schema, app: turn.app }));
    await write('kelay/policy.ts', policyFile(policy));
    await write('kelay/graphs.ts', graphsFile([graph]));

    emit({ type: 'step', text: 'Generated the board screen' });
    await cp(join(SCREENS, 'app/page.tsx'), join(turn.dir, 'app/page.tsx'));
    emit({ type: 'file', path: 'app/page.tsx', change: 'modified' });
    await appendFile(join(turn.dir, 'app/globals.css'), await readFile(join(SCREENS, 'board.css'), 'utf8'));
    emit({ type: 'file', path: 'app/globals.css', change: 'modified' });
    const layout = join(turn.dir, 'app/layout.tsx');
    await writeFile(layout, (await readFile(layout, 'utf8')).replace("title: 'New Kelay app'", "title: 'Ticket Board'"));
    emit({ type: 'file', path: 'app/layout.tsx', change: 'modified' });

    return {
      text:
        'I built a **Ticket Board**: To do, In progress, Review and Done columns, tickets you can drag between them, and comments on each ticket. ' +
        'Admins can change everything; members move their own tickets; guests can read and comment.\n\n' +
        'This Builder is running its scripted demo agent, because no model key is configured, so it builds this same app whatever the prompt says. ' +
        'Set `ANTHROPIC_API_KEY` to have Claude build from what you write.',
    };
  }

  private async addPriority(schemaPath: string, schema: { collections: { name: string; fields: Record<string, unknown> }[] }, emit: (event: AgentEvent) => void): Promise<AgentResult> {
    const tickets = schema.collections.find((c) => c.name === 'tickets')!;
    if (tickets.fields.priority) return { text: 'Tickets already have a priority field, so there was nothing to change.' };
    emit({ type: 'step', text: 'Added a priority field to tickets' });
    tickets.fields.priority = { type: 'text', description: 'low | medium | high' };
    await writeFile(schemaPath, schemaFile(schema));
    emit({ type: 'file', path: 'kelay/schema.ts', change: 'modified' });
    return {
      text:
        'Tickets now have a **priority** field (low, medium or high). The Development database gets the new column with this deploy. ' +
        'The scripted demo agent stops there: it doesn’t change the board screen to show it.',
    };
  }
}
