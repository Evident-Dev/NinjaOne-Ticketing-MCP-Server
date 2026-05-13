export interface AppConfig {
  port: number;
  ninjaTokenUrl: string;
  ninjaAuthorizeUrl: string;
  ninjaApiBaseUrl: string;
  ninjaClientId: string;
  ninjaClientSecret: string;
  oauthRedirectUri: string;
  oauthScope: string;
  tokenStorePath: string;
  sessionStorePath: string;
  publicBaseUrl?: string;
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

function deriveAuthorizeUrl(tokenUrl: string): string {
  // NinjaOne's canonical OAuth paths live under /ws/oauth/. The token endpoint
  // is forgiving (both /oauth/token and /ws/oauth/token work), but /authorize
  // must be /ws/oauth/authorize. Normalize regardless of which form the user
  // configured for NINJA_TOKEN_URL.
  return tokenUrl.replace(/\/(?:ws\/)?oauth\/token\/?$/, "/ws/oauth/authorize");
}

export function loadConfig(): AppConfig {
  const tokenUrl = optional("NINJA_TOKEN_URL");
  const railwayDomain = optional("RAILWAY_PUBLIC_DOMAIN");
  const publicBase =
    optional("PUBLIC_BASE_URL").replace(/\/$/, "") ||
    (railwayDomain ? `https://${railwayDomain}` : "");
  const explicitRedirect = optional("OAUTH_REDIRECT_URI");

  return {
    port: Number(process.env.PORT || 3000),
    ninjaTokenUrl: tokenUrl,
    ninjaAuthorizeUrl: optional("NINJA_AUTHORIZE_URL") || deriveAuthorizeUrl(tokenUrl),
    ninjaApiBaseUrl: optional("NINJA_API_BASE_URL").replace(/\/$/, ""),
    ninjaClientId: optional("NINJA_CLIENT_ID"),
    ninjaClientSecret: optional("NINJA_CLIENT_SECRET"),
    oauthRedirectUri: explicitRedirect || (publicBase ? `${publicBase}/auth/callback` : ""),
    oauthScope: optional("OAUTH_SCOPE") || "monitoring management offline_access",
    tokenStorePath: optional("TOKEN_STORE_PATH") || "/data/ninja-token.json",
    sessionStorePath: optional("SESSION_STORE_PATH") || "/data/sessions.json",
    publicBaseUrl: publicBase || undefined,
    mcpSharedSecret: process.env.MCP_SHARED_SECRET?.trim() || undefined,
    defaultTicketFormId: optionalNumber("DEFAULT_TICKET_FORM_ID"),
    defaultBoardId: optionalNumber("DEFAULT_BOARD_ID"),
    technicianEmail: process.env.TECHNICIAN_EMAIL?.trim() || undefined
  };
}
