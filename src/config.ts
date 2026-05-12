export interface AppConfig {
  port: number;
  ninjaTokenUrl: string;
  ninjaApiBaseUrl: string;
  ninjaClientId: string;
  ninjaClientSecret: string;
  mcpSharedSecret?: string;
  defaultTicketFormId?: number;
  defaultBoardId?: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number if set`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT || 3000),
    ninjaTokenUrl: required("NINJA_TOKEN_URL"),
    ninjaApiBaseUrl: required("NINJA_API_BASE_URL").replace(/\/$/, ""),
    ninjaClientId: required("NINJA_CLIENT_ID"),
    ninjaClientSecret: required("NINJA_CLIENT_SECRET"),
    mcpSharedSecret: process.env.MCP_SHARED_SECRET?.trim() || undefined,
    defaultTicketFormId: optionalNumber("DEFAULT_TICKET_FORM_ID"),
    defaultBoardId: optionalNumber("DEFAULT_BOARD_ID")
  };
}
