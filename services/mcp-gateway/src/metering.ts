// One record per tool call (contract §7). Monitoring reads these lines to list "personal agent" calls.

export interface McpCallRecord {
  type: 'mcp_call';
  app: string;
  sub: string;
  /** The MCP client id (`azp`). */
  client: string;
  tool: string;
  ms: number;
  ok: boolean;
}

export type MeterSink = (record: McpCallRecord) => void;

export const stdoutMeter: MeterSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
