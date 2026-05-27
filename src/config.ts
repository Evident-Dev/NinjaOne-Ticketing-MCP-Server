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

export interface AppConfig {
  port: number;
  ninjaRegion: NinjaRegion;
  ninjaBaseUrl: string;     // e.g. https://app.ninjarmm.com
  ninjaTokenUrl: string;    // e.g. https://app.ninjarmm.com/oauth/token (or instance URL)
  ninjaApiBaseUrl: string;  // e.g. https://app.ninjarmm.com/api/v2 (or instance URL)
  ninjaClientId: string;
  ninjaClientSecret: string;
  oauthScope: string;
  mcpSharedSecret?: string;
  defaultTicketFormId?: number;
  defaultBoardId?: number;
  technicianEmail?: string;
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

  return {
    port: Number(process.env.PORT || 3000),
    ninjaRegion,
    ninjaBaseUrl,
    ninjaTokenUrl,
    ninjaApiBaseUrl,
    ninjaClientId: optional("NINJA_CLIENT_ID"),
    ninjaClientSecret: optional("NINJA_CLIENT_SECRET"),
    oauthScope: optional("OAUTH_SCOPE") || "monitoring management",
    mcpSharedSecret: process.env.MCP_SHARED_SECRET?.trim() || undefined,
    defaultTicketFormId: optionalNumber("DEFAULT_TICKET_FORM_ID"),
    defaultBoardId: optionalNumber("DEFAULT_BOARD_ID"),
    technicianEmail: process.env.TECHNICIAN_EMAIL?.trim() || undefined
  };
}
