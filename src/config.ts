export interface AppConfig {
  port: number;
  ninjaTokenUrl: string;
  ninjaApiBaseUrl: string;
  ninjaClientId: string;
  ninjaClientSecret: string;
  mcpSharedSecret?: string;
  defaultTicketFormId?: number;
  defaultBoardId?: number;
  technicianEmail?: string;
}

const REQUIRED = ["NINJA_TOKEN_URL", "NINJA_API_BASE_URL", "NINJA_CLIENT_ID", "NINJA_CLIENT_SECRET"] as const;

export function getMissingVars(): string[] {
  return REQUIRED.filter((name) => !process.env[name]?.trim());
}

function optional(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function optionalNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT || 3000),
    ninjaTokenUrl: optional("NINJA_TOKEN_URL"),
    ninjaApiBaseUrl: optional("NINJA_API_BASE_URL").replace(/\/$/, ""),
    ninjaClientId: optional("NINJA_CLIENT_ID"),
    ninjaClientSecret: optional("NINJA_CLIENT_SECRET"),
    mcpSharedSecret: process.env.MCP_SHARED_SECRET?.trim() || undefined,
    defaultTicketFormId: optionalNumber("DEFAULT_TICKET_FORM_ID"),
    defaultBoardId: optionalNumber("DEFAULT_BOARD_ID"),
    technicianEmail: process.env.TECHNICIAN_EMAIL?.trim() || undefined
  };
}
