import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { NinjaClient } from "../ninja.js";

export interface DomainContext {
  server: McpServer;
  ninja: NinjaClient;
  config: AppConfig;
}

export type DomainRegister = (ctx: DomainContext) => void;

export function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
