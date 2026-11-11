import { ClaudeCodingAgent } from './claude.ts';
import { ScriptedAgent } from './scripted.ts';
import type { CodingAgent } from './types.ts';

export interface AgentEnv {
  BUILDER_AGENT?: string | undefined;
  BUILDER_MODEL?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_BASE_URL?: string | undefined;
}

/**
 * `BUILDER_AGENT=claude|scripted`. Unset: claude when an API key is present, else scripted. Asking for
 * claude without a key is an error rather than a quiet fall back to the demo agent.
 */
export function selectAgent(env: AgentEnv, configDir: string): CodingAgent {
  const wanted = env.BUILDER_AGENT?.trim() || (env.ANTHROPIC_API_KEY ? 'claude' : 'scripted');
  if (wanted === 'scripted') return new ScriptedAgent();
  if (wanted !== 'claude') throw new Error(`BUILDER_AGENT must be claude or scripted, got ${JSON.stringify(wanted)}`);
  if (!env.ANTHROPIC_API_KEY) throw new Error('BUILDER_AGENT=claude needs ANTHROPIC_API_KEY (an Anthropic API key, or the LLM gateway key with ANTHROPIC_BASE_URL)');
  return new ClaudeCodingAgent({
    apiKey: env.ANTHROPIC_API_KEY,
    configDir,
    ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.BUILDER_MODEL ? { model: env.BUILDER_MODEL } : {}),
  });
}
