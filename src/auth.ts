import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  access_token_expires_at?: number;
  scope?: string;
  obtained_at: number;
}

interface PendingState {
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export class TokenStore {
  private cached: StoredToken | null | undefined;

  constructor(private readonly path: string) {}

  async load(): Promise<StoredToken | null> {
    if (this.cached !== undefined) return this.cached;
    try {
      const raw = await readFile(this.path, "utf8");
      this.cached = JSON.parse(raw) as StoredToken;
      return this.cached;
    } catch (error: unknown) {
      if (isNoEnt(error)) {
        this.cached = null;
        return null;
      }
      throw error;
    }
  }

  async save(token: StoredToken): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(token, null, 2), { mode: 0o600 });
    this.cached = token;
  }

  async clear(): Promise<void> {
    this.cached = null;
    try {
      await writeFile(this.path, "", { mode: 0o600 });
    } catch {
      // ignore
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export class StateCache {
  private states = new Map<string, PendingState>();

  create(): string {
    this.gc();
    const state = randomBytes(32).toString("hex");
    this.states.set(state, { createdAt: Date.now() });
    return state;
  }

  consume(state: string): boolean {
    this.gc();
    const found = this.states.delete(state);
    return found;
  }

  private gc(): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [key, value] of this.states) {
      if (value.createdAt < cutoff) this.states.delete(key);
    }
  }
}

export function buildAuthorizeUrl(config: AppConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.ninjaClientId,
    redirect_uri: config.oauthRedirectUri,
    scope: config.oauthScope,
    state,
    prompt: "login"
  });
  const ninjaAuthorize = `${config.ninjaAuthorizeUrl}?${params.toString()}`;
  // See oauth-server.ts: chain through NinjaOne root so login kicks in if
  // there's no active session.
  const origin = new URL(config.ninjaAuthorizeUrl).origin;
  const path = new URL(ninjaAuthorize).pathname + new URL(ninjaAuthorize).search;
  return `${origin}/?return_to=${encodeURIComponent(path)}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export async function exchangeCodeForTokens(config: AppConfig, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.ninjaClientId,
    client_secret: config.ninjaClientSecret,
    code,
    redirect_uri: config.oauthRedirectUri
  });
  return postToken(config, body);
}

export async function refreshAccessToken(config: AppConfig, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.ninjaClientId,
    client_secret: config.ninjaClientSecret,
    refresh_token: refreshToken,
    scope: config.oauthScope
  });
  return postToken(config, body);
}

async function postToken(config: AppConfig, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(config.ninjaTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`NinjaOne token endpoint ${response.status}: ${text.slice(0, 500)}`);
  }
  return (await response.json()) as TokenResponse;
}

export function loginUrl(config: AppConfig): string {
  if (!config.publicBaseUrl) return "/auth/login";
  const url = `${config.publicBaseUrl}/auth/login`;
  if (config.mcpSharedSecret) return `${url}?token=${encodeURIComponent(config.mcpSharedSecret)}`;
  return url;
}

export function decodeJwt(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Pull a likely email or username out of common JWT claims.
export function emailFromJwt(claims: Record<string, unknown>): string | undefined {
  const candidates = ["email", "preferred_username", "unique_name", "upn", "username"];
  for (const key of candidates) {
    const value = claims[key];
    if (typeof value === "string" && value.includes("@")) return value;
  }
  return undefined;
}

function isNoEnt(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
