// `action_<name>` tools hand off to an ActionRunner. The real runner will start the action's agent graph
// as the calling user (infrastructure §4.5); until then the default answers with a tool error.
import type { ActionDef, KelayClaims } from '@kelay/contracts';

export interface ActionCall {
  app: string;
  action: ActionDef;
  input: Record<string, unknown>;
  claims: KelayClaims;
  /** The user's MCP token, for calls the run makes as that user. */
  userToken: string;
}

export type ActionOutcome = { ok: true; output: unknown } | { ok: false; message: string };

export interface ActionRunner {
  run(call: ActionCall): Promise<ActionOutcome>;
}

export const unavailableActionRunner: ActionRunner = {
  async run({ action }) {
    return { ok: false, message: `The "${action.name}" action isn't available yet.` };
  },
};
