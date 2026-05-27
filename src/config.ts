// NinjaOne regional endpoints. The OAuth token endpoint lives at /oauth/token
// (also reachable via /ws/oauth/token) on these same hosts, and the REST API
// lives under /api/v2.
const REGION_BASE_URLS = {
  us: "https://app.ninjarmm.com",
  eu: "https://eu.ninjarmm.com",
  oc: "https://oc.ninjarmm.com",
  ca: "https://ca.ninjarmm.com",
  us2: "https://us2.ninjarmm.com",
  fed: "https://app.ninjaone.us"
} as const;

export type NinjaRegion = keyof typeof REGION_BASE_URLS;

const VALID_REGIONS = Object.keys(REGION_BASE_URLS) as NinjaRegion[];

export interface TechnicianEntry {
  email: string;
  token: string;
  name?: string;
}

export interface AppConfig {
  port: number;
  ninjaRegion: NinjaRegion;
  ninjaBaseUrl: string;     // e.g. https://app.ninjarmm.com
  ninjaTokenUrl: string;    // e.g. https://app.ninjarmm.com/ws/oauth/token (or instance URL)
  ninjaAuthorizeUrl: string;// e.g. https://app.ninjarmm.com/ws/oauth/authorize
  ninjaApiBaseUrl: string;  // e.g. https://app.ninjarmm.com/api/v2 (or instance URL)
  ninjaClientId: string;
  ninjaClientSecret: string;
  oauthScope: string;
  publicBaseUrl?: string;   // public URL of this MCP server, used to build /auth/callback
  oauthRedirectUri?: string;
  userTokenPath: string;    // where the refresh token is persisted on disk
  mcpSharedSecret?: string;
  technicians: TechnicianEntry[];  // env-var fallback allowlist (used if no DATABASE_URL)
  databaseUrl?: string;            // Railway Postgres connection string
  defaultTicketFormId?: number;
  defaultBoardId?: number;
  technicianEmail?: string;
  // Capability allowlist for destructive tools. Comma-separated keys, e.g.
  // "ticket_delete,device_delete,alert_reset_all". Tools whose key isn't here
  // are NOT registered — the model can't see what it can't call.
  destructiveAllowlist: Set<string>;
}

const REQUIRED = ["NINJA_CLIENT_ID", "NINJA_CLIENT_SECRET"] as const;

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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Parses NINJA_TECHNICIANS — accepts either:
//   JSON array:   [{"email":"alice@x.com","token":"abc","name":"Alice"}, ...]
//   Compact CSV:  alice@x.com:abc:Alice,bob@x.com:def:Bob   (name optional)
// Returns [] if unset. Logs a warning on parse error but does not throw — the
// server still boots with no allowlist, falling back to MCP_SHARED_SECRET.
function parseTechnicians(raw: string): TechnicianEntry[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as Array<{ email?: string; token?: string; name?: string }>;
      return arr
        .filter((e) => typeof e?.email === "string" && typeof e?.token === "string")
        .map((e) => ({ email: e.email!.toLowerCase(), token: e.token!, name: e.name }));
    } catch (err) {
      console.warn("Failed to parse NINJA_TECHNICIANS as JSON:", (err as Error).message);
      return [];
    }
  }
  // CSV form: email:token[:name], comma-separated
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): TechnicianEntry | null => {
      const [email, token, ...nameParts] = entry.split(":");
      if (!email || !token) return null;
      const name = nameParts.join(":");
      return name
        ? { email: email.toLowerCase(), token, name }
        : { email: email.toLowerCase(), token };
    })
    .filter((e): e is TechnicianEntry => e !== null);
}

export function loadConfig(): AppConfig {
  const regionInput = optional("NINJA_REGION").toLowerCase() || "us";
  if (!(VALID_REGIONS as string[]).includes(regionInput)) {
    throw new Error(
      `Invalid NINJA_REGION '${regionInput}'. Valid regions: ${VALID_REGIONS.join(", ")}`
    );
  }
  const ninjaRegion = regionInput as NinjaRegion;
  const regionBase = REGION_BASE_URLS[ninjaRegion];

  // Explicit URL overrides win — useful for partner/whitelabel instances on
  // non-standard hostnames (rmmservices.net etc).
  const explicitBase = stripTrailingSlash(optional("NINJA_BASE_URL"));
  const ninjaBaseUrl = explicitBase || regionBase;
  const ninjaApiBaseUrl =
    stripTrailingSlash(optional("NINJA_API_BASE_URL")) || `${ninjaBaseUrl}/api/v2`;
  const ninjaTokenUrl =
    stripTrailingSlash(optional("NINJA_TOKEN_URL")) || `${ninjaBaseUrl}/ws/oauth/token`;
  const ninjaAuthorizeUrl =
    stripTrailingSlash(optional("NINJA_AUTHORIZE_URL")) || `${ninjaBaseUrl}/ws/oauth/authorize`;

  // Railway exposes RAILWAY_PUBLIC_DOMAIN automatically once a domain is generated.
  const railwayDomain = optional("RAILWAY_PUBLIC_DOMAIN");
  const publicBase =
    stripTrailingSlash(optional("PUBLIC_BASE_URL")) ||
    (railwayDomain ? `https://${railwayDomain}` : "");
  const explicitRedirect = optional("OAUTH_REDIRECT_URI");
  const oauthRedirectUri = explicitRedirect || (publicBase ? `${publicBase}/auth/callback` : "");

  return {
    port: Number(process.env.PORT || 3000),
    ninjaRegion,
    ninjaBaseUrl,
    ninjaTokenUrl,
    ninjaAuthorizeUrl,
    ninjaApiBaseUrl,
    ninjaClientId: optional("NINJA_CLIENT_ID"),
    ninjaClientSecret: optional("NINJA_CLIENT_SECRET"),
    // offline_access is REQUIRED to receive a refresh_token from NinjaOne.
    // Without it, every browser sign-in produces only a short-lived access token
    // and the user has to re-authorize constantly.
    oauthScope: optional("OAUTH_SCOPE") || "monitoring management offline_access",
    publicBaseUrl: publicBase || undefined,
    oauthRedirectUri: oauthRedirectUri || undefined,
    userTokenPath: optional("USER_TOKEN_PATH") || "/data/refresh-token.json",
    mcpSharedSecret: process.env.MCP_SHARED_SECRET?.trim() || undefined,
    technicians: parseTechnicians(optional("NINJA_TECHNICIANS")),
    databaseUrl: optional("DATABASE_URL") || undefined,
    defaultTicketFormId: optionalNumber("DEFAULT_TICKET_FORM_ID"),
    defaultBoardId: optionalNumber("DEFAULT_BOARD_ID"),
    technicianEmail: process.env.TECHNICIAN_EMAIL?.trim() || undefined,
    destructiveAllowlist: parseAllowlist(optional("NINJA_ALLOW_DESTRUCTIVE"))
  };
}

function parseAllowlist(raw: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
