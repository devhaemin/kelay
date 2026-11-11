// The claude path with the Agent SDK mocked: these tests check what the Builder asks of the SDK and
// how it reads the SDK's messages. They do not call the model.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agents/types.ts';

const sdk = vi.hoisted(() => ({ calls: [] as { prompt: string; options: Record<string, any> }[], messages: [] as unknown[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: Record<string, any> }) => {
    sdk.calls.push(params);
    return (async function* () {
      yield* sdk.messages;
    })();
  },
}));

const { ClaudeCodingAgent, workspaceGuard } = await import('../src/agents/claude.ts');
const { selectAgent } = await import('../src/agents/select.ts');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kelay-agent-')));
const configDir = join(dir, '.agent-home');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const init = (apiKeySource = 'ANTHROPIC_API_KEY') => ({ type: 'system', subtype: 'init', session_id: 'sess-1', apiKeySource });
const assistant = (...content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content } });
const success = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result });

const turn = { app: 'team-board', dir, kind: 'build' as const, prompt: 'A ticket board for my team' };

beforeEach(() => {
  sdk.calls.length = 0;
  sdk.messages = [];
});

describe('ClaudeCodingAgent', () => {
  it('runs in the workspace with an API key from the environment and file tools only', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-be-passed-on';
    process.env.KELAY_CALLER_SECRET = 'must-not-be-passed-on';
    sdk.messages = [init(), assistant({ type: 'text', text: 'Done.' }), success('Done.')];
    const agent = new ClaudeCodingAgent({ apiKey: 'test-api-key', configDir });
    expect(agent.info).toEqual({ kind: 'claude', model: 'claude-opus-5-5' });

    await agent.run(turn, () => {});

    const { prompt, options } = sdk.calls[0]!;
    expect(prompt).toContain('Build the first version of this app');
    expect(prompt).toContain('A ticket board for my team');
    expect(options).toMatchObject({
      cwd: dir,
      model: 'claude-opus-5-5',
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'default',
      settingSources: ['project'],
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });
    expect(options.resume).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    // The environment is built from scratch: the key, its own config dir, and nothing that could be a login.
    expect(options.env).toMatchObject({ ANTHROPIC_API_KEY: 'test-api-key', CLAUDE_CONFIG_DIR: configDir, HOME: configDir });
    const inherited = ['LANG', 'PATH', 'TMPDIR'].filter((k) => process.env[k]);
    expect(Object.keys(options.env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', ...inherited].sort(),
    );
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.KELAY_CALLER_SECRET;
  });

  it('goes through the LLM gateway and another model when configured, and resumes the conversation', async () => {
    sdk.messages = [init(), success('ok')];
    const agent = new ClaudeCodingAgent({ apiKey: 'gateway-key', baseUrl: 'http://localhost:4000', model: 'claude-sonnet-5-5', configDir });
    const result = await agent.run({ ...turn, kind: 'message', prompt: 'Add labels', context: 'Screen · Board', sessionId: 'sess-0' }, () => {});
    const { prompt, options } = sdk.calls[0]!;
    expect(options).toMatchObject({ model: 'claude-sonnet-5-5', resume: 'sess-0', env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'gateway-key' } });
    expect(prompt).toBe('The builder is looking at: Screen · Board\n\nAdd labels');
    expect(result).toEqual({ text: 'ok', sessionId: 'sess-1' });
  });

  it('turns the SDK’s messages into steps, file changes and the reply', async () => {
    sdk.messages = [
      init(),
      assistant({ type: 'thinking', thinking: '' }, { type: 'text', text: 'I’ll add the tickets collection.' }),
      assistant({ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'kelay/schema.ts') } }),
      assistant({ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'kelay/schema.ts') } }),
      { type: 'assistant', parent_tool_use_id: 'sub-1', message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
      assistant({ type: 'tool_use', name: 'Write', input: { file_path: 'app/page.tsx' } }),
      assistant({ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'kelay/schema.ts') } }),
      assistant({ type: 'text', text: 'Your board is ready.' }),
      success('Your board is ready.'),
    ];
    const events: AgentEvent[] = [];
    const result = await new ClaudeCodingAgent({ apiKey: 'k', configDir }).run(turn, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'text', text: 'I’ll add the tickets collection.' },
      { type: 'step', text: 'Editing kelay/schema.ts' },
      { type: 'file', path: 'kelay/schema.ts', change: 'modified' },
      { type: 'step', text: 'Editing app/page.tsx' },
      { type: 'file', path: 'app/page.tsx', change: 'created' },
      { type: 'file', path: 'kelay/schema.ts', change: 'modified' },
      { type: 'text', text: 'Your board is ready.' },
    ]);
    expect(result).toEqual({ text: 'Your board is ready.', sessionId: 'sess-1' });
  });

  it('stops when the SDK authenticated with anything but the API key', async () => {
    sdk.messages = [init('none'), assistant({ type: 'text', text: 'should never be read' }), success('x')];
    const events: AgentEvent[] = [];
    await expect(new ClaudeCodingAgent({ apiKey: 'k', configDir }).run(turn, (e) => events.push(e))).rejects.toThrow('did not authenticate with ANTHROPIC_API_KEY (credential source: none)');
    expect(events).toEqual([]);
    expect(sdk.calls[0]!.options.abortController.signal.aborted).toBe(true);
  });

  it('fails the turn on an error result, a failed model call or a stream without a result', async () => {
    const agent = new ClaudeCodingAgent({ apiKey: 'k', configDir });
    sdk.messages = [init(), { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }];
    await expect(agent.run(turn, () => {})).rejects.toThrow('the coding agent stopped: error_max_turns');
    sdk.messages = [init(), { ...assistant(), error: 'authentication_failed' }];
    await expect(agent.run(turn, () => {})).rejects.toThrow('the model call failed: authentication_failed');
    sdk.messages = [init()];
    await expect(agent.run(turn, () => {})).rejects.toThrow('ended without a result');
    expect(() => new ClaudeCodingAgent({ apiKey: '', configDir })).toThrow('needs ANTHROPIC_API_KEY');
  });
});

describe('workspaceGuard', () => {
  const guard = workspaceGuard(dir);
  const ask = async (tool: string, input: Record<string, unknown>) => (await guard(tool, input, { signal: new AbortController().signal } as never))?.behavior;

  it('allows file tools inside the workspace', async () => {
    expect(await ask('Write', { file_path: join(dir, 'app/page.tsx') })).toBe('allow');
    expect(await ask('Edit', { file_path: 'kelay/schema.ts' })).toBe('allow');
    expect(await ask('Read', { file_path: join(dir, 'lib/kelay.ts') })).toBe('allow');
    expect(await ask('Grep', { pattern: 'useCollection' })).toBe('allow');
  });

  it('denies paths outside it, environment files, platform files and other tools', async () => {
    expect(await ask('Read', { file_path: '/etc/hosts' })).toBe('deny');
    expect(await ask('Write', { file_path: join(dir, '../other-app/app/page.tsx') })).toBe('deny');
    expect(await ask('Glob', { pattern: '*', path: '/Users' })).toBe('deny');
    expect(await ask('Read', { file_path: join(dir, '.env.local') })).toBe('deny');
    expect(await ask('Write', { file_path: join(dir, '.env') })).toBe('deny');
    for (const path of ['lib/kelay.ts', 'app/api/kelay/[...path]/route.ts', 'kelay/manifest.ts', 'package.json', 'next.config.ts', 'CLAUDE.md', 'node_modules/next/index.js', '.git/config']) {
      expect(await ask('Edit', { file_path: join(dir, path) }), path).toBe('deny');
    }
    expect(await ask('Write', {})).toBe('deny');
    expect(await ask('Bash', { command: 'ls' })).toBe('deny');
    expect(await ask('WebFetch', { url: 'https://example.com' })).toBe('deny');
  });
});

describe('selectAgent', () => {
  it('is claude when a key is present and scripted otherwise', () => {
    expect(selectAgent({}, configDir).info).toEqual({ kind: 'scripted', model: null });
    expect(selectAgent({ ANTHROPIC_API_KEY: '' }, configDir).info.kind).toBe('scripted');
    expect(selectAgent({ ANTHROPIC_API_KEY: 'k' }, configDir).info).toEqual({ kind: 'claude', model: 'claude-opus-5-5' });
    expect(selectAgent({ ANTHROPIC_API_KEY: 'k', BUILDER_MODEL: 'claude-haiku-5-5' }, configDir).info.model).toBe('claude-haiku-5-5');
  });

  it('follows BUILDER_AGENT, and never falls back quietly', () => {
    expect(selectAgent({ BUILDER_AGENT: 'scripted', ANTHROPIC_API_KEY: 'k' }, configDir).info.kind).toBe('scripted');
    expect(() => selectAgent({ BUILDER_AGENT: 'claude' }, configDir)).toThrow('needs ANTHROPIC_API_KEY');
    expect(() => selectAgent({ BUILDER_AGENT: 'gpt' }, configDir)).toThrow('must be claude or scripted');
  });
});
