// The Builder with a model: the Claude Agent SDK (Claude Code as a library) working in the workspace
// directory. It authenticates with an API key from the environment only, directly at Anthropic or
// through the LLM gateway (ANTHROPIC_BASE_URL plus the gateway key). A claude.ai login is never used.
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { query, type CanUseTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo } from '../events.ts';
import { AgentError, type AgentEvent, type AgentResult, type AgentTurn, type CodingAgent } from './types.ts';

export const DEFAULT_BUILDER_MODEL = 'claude-opus-5-5';

/** File tools only. There is no shell: the platform runs the check, the commit and the deploy itself. */
export const AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/** Paths the template marks as platform files (templates/starter/CLAUDE.md). A trailing slash covers the folder. */
export const PROTECTED_PATHS = ['lib/kelay.ts', 'kelay/manifest.ts', 'app/api/kelay/', 'next.config.ts', 'package.json', 'tsconfig.json', 'CLAUDE.md', '.gitignore', '.git/', 'node_modules'];

const SYSTEM_APPEND = `You are the Builder agent of Kelay, working in one Kelay app. CLAUDE.md in this folder holds the rules of the app and they are binding.
You have file tools only and they work inside this folder. After your turn the platform commits your changes, checks kelay/schema.ts, kelay/policy.ts and kelay/graphs.ts, and deploys to Development. When the check fails you are told what to fix.
The person you answer is a builder, not a programmer: finish with a short plain reply about what changed and what to look at in the preview.`;

export interface ClaudeAgentOptions {
  /** ANTHROPIC_API_KEY: an Anthropic API key, or the LLM gateway's key when `baseUrl` is the gateway. */
  apiKey: string;
  /** ANTHROPIC_BASE_URL, for the LLM gateway. */
  baseUrl?: string;
  model?: string;
  /** Claude Code's config directory for this service. It is kept apart from any person's ~/.claude, so no stored login can be picked up. */
  configDir: string;
  maxTurns?: number;
  /** The SDK's `query`; tests pass their own. */
  query?: typeof query;
}

const isInside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** Allows a file tool only on paths inside the workspace, and writes only outside the platform files. */
export function workspaceGuard(dir: string): CanUseTool {
  return async (toolName, input) => {
    const deny = (message: string) => ({ behavior: 'deny' as const, message });
    if (!AGENT_TOOLS.includes(toolName)) return deny(`${toolName} is not available in a Builder workspace.`);
    const target = [input.file_path, input.path].find((p): p is string => typeof p === 'string');
    if (target === undefined) return WRITE_TOOLS.has(toolName) ? deny('A file path is required.') : { behavior: 'allow', updatedInput: input };
    const path = resolve(dir, target);
    if (!isInside(dir, path)) return deny('Only files inside this app’s folder can be read or changed.');
    const rel = relative(dir, path).split(sep).join('/');
    if (/(^|\/)\.env(\.|$)/.test(rel)) return deny('Environment files are off limits: the app holds no secrets.');
    if (WRITE_TOOLS.has(toolName) && PROTECTED_PATHS.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p || rel.startsWith(`${p}/`)))) {
      return deny(`${rel} is a platform file. Say in your reply what you would need changed there.`);
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

const promptFor = (turn: AgentTurn) =>
  [
    turn.kind === 'build'
      ? 'Build the first version of this app from the builder’s description. Replace the starter notes example with what they describe: the data in kelay/schema.ts, the access rules in kelay/policy.ts, and the first screen in app/page.tsx.'
      : turn.kind === 'improvement'
        ? 'Implement this approved improvement proposal for the app.'
        : null,
    turn.context ? `The builder is looking at: ${turn.context}` : null,
    turn.prompt,
  ]
    .filter(Boolean)
    .join('\n\n');

export class ClaudeCodingAgent implements CodingAgent {
  readonly info: AgentInfo;
  private readonly run_: typeof query;

  constructor(private readonly opts: ClaudeAgentOptions) {
    if (!opts.apiKey) throw new Error('the claude Builder agent needs ANTHROPIC_API_KEY');
    this.info = { kind: 'claude', model: opts.model ?? DEFAULT_BUILDER_MODEL };
    this.run_ = opts.query ?? query;
  }

  /** The whole environment of the agent process. Nothing is inherited, so no login token or other secret of this service reaches it. */
  private env(): Record<string, string> {
    const inherit = (name: string) => (process.env[name] ? { [name]: process.env[name]! } : {});
    return {
      ...inherit('PATH'),
      ...inherit('TMPDIR'),
      ...inherit('LANG'),
      HOME: this.opts.configDir,
      CLAUDE_CONFIG_DIR: this.opts.configDir,
      ANTHROPIC_API_KEY: this.opts.apiKey,
      ...(this.opts.baseUrl ? { ANTHROPIC_BASE_URL: this.opts.baseUrl } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: 'kelay-builder/0.1.0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    };
  }

  async run(turn: AgentTurn, emit: (event: AgentEvent) => void): Promise<AgentResult> {
    await mkdir(this.opts.configDir, { recursive: true });
    const dir = realpathSync(turn.dir);
    const abort = new AbortController();
    turn.signal?.addEventListener('abort', () => abort.abort(), { once: true });

    const options: Options = {
      cwd: dir,
      model: this.info.model!,
      env: this.env(),
      // CLAUDE.md of the workspace, and nothing from a person's own settings.
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
      tools: AGENT_TOOLS,
      permissionMode: 'default',
      canUseTool: workspaceGuard(dir),
      settings: { permissions: { deny: ['Read(./.env)', 'Read(./.env.*)'] } },
      strictMcpConfig: true,
      maxTurns: this.opts.maxTurns ?? 60,
      abortController: abort,
      ...(turn.sessionId ? { resume: turn.sessionId } : {}),
    };

    let text = '';
    let sessionId: string | null = turn.sessionId ?? null;
    const seen = new Set<string>();
    for await (const message of this.run_({ prompt: promptFor(turn), options }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        if (message.apiKeySource !== 'ANTHROPIC_API_KEY') {
          abort.abort();
          throw new AgentError(`the coding agent did not authenticate with ANTHROPIC_API_KEY (credential source: ${message.apiKeySource}), so the turn was stopped`);
        }
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        if (message.error) throw new AgentError(`the model call failed: ${message.error}`);
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            text = block.text.trim();
            emit({ type: 'text', text });
          } else if (block.type === 'tool_use' && WRITE_TOOLS.has(block.name)) {
            const target = (block.input as { file_path?: unknown }).file_path;
            if (typeof target !== 'string') continue;
            const path = relative(dir, resolve(dir, target)).split(sep).join('/');
            if (!seen.has(path)) emit({ type: 'step', text: `Editing ${path}` });
            seen.add(path);
            emit({ type: 'file', path, change: block.name === 'Write' ? 'created' : 'modified' });
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
          const why = message.subtype === 'success' ? message.result : message.errors.join('; ') || message.subtype;
          throw new AgentError(`the coding agent stopped: ${why}`);
        }
        // The closing reply was already streamed as assistant text; `result` repeats it.
        return { text: message.result.trim() || text, sessionId };
      }
    }
    throw new AgentError('the coding agent ended without a result');
  }
}
