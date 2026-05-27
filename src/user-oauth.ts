// User-context OAuth (Authorization Code + Refresh Token) for NinjaOne.
//
// Why this exists: NinjaOne's ticket-write endpoints (POST /ticketing/ticket,
// PUT, comment) require a user-context token. Client-credentials machine tokens
// get 403 user_context_required. So a real tech must log in once via browser,
// and we persist the refresh_token to use for all subsequent writes.
//
// CRITICAL — refresh token rotation:
// NinjaOne issues a NEW refresh_token on every refresh exchange. The old one is
// invalidated immediately. If you fail to persist the new one before returning
// the access token to the caller, the next call breaks irrecoverably. This
// module persists FIRST, then returns the access token. Atomic file writes
// (write-tmp-then-rename) prevent half-written corruption.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import type { NinjaTokenResponse } from "./types.js";

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export interface StoredTokens {
  refresh_token: string;
  base_url: string;
  scope?: string;
  saved_at: number;
  last_refreshed_at?: number;
  user_email?: string;
}

export type UserOAuthErrorKind =
  | "no-token"        // No refresh token on disk
  | "refresh-failed"  // NinjaOne rejected the refresh (token expired / revoked)
  | "exchange-failed" // Code-for-token exchange failed
  | "save-failed";    // Couldn't persist the rotated token

export class UserOAuthError extends Error {
  readonly kind: UserOAuthErrorKind;
  readonly loginUrl?: string;

  constructor(message: string, kind: UserOAuthErrorKind, loginUrl?: string) {
    super(message);
    this.name = "UserOAuthError";
    this.kind = kind;
    this.loginUrl = loginUrl;
  }
}

export class UserOAuth {
  private cachedAccessToken: string | null = null;
  private cachedExpiry = 0;
  private stored: StoredTokens | null = null;
  private storedLoaded = false;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly config: AppConfig) {}

  // ── Persistence ──────────────────────────────────────────────────────────

  async loadStored(): Promise<StoredTokens | null> {
    if (this.storedLoaded) return this.stored;
    try {
      const raw = await fs.readFile(this.config.userTokenPath, "utf8");
      this.stored = JSON.parse(raw) as StoredTokens;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        console.warn(
          `Failed to read refresh token from ${this.config.userTokenPath}:`,
          e.message
        );
      }
      this.stored = null;
    }
    this.storedLoaded = true;
    return this.stored;
  }

  // Atomic write: writeFile to .tmp, then rename. Prevents partial writes from
  // corrupting the on-disk token in case of crash/power-loss mid-write.
  private async saveStored(tokens: StoredTokens): Promise<void> {
    const path = this.config.userTokenPath;
    const dir = dirname(path);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new UserOAuthError(
        `Cannot create token directory ${dir}: ${(err as Error).message}. ` +
          `If running on Railway, mount a volume at ${dir} or set USER_TOKEN_PATH to a writable location.`,
        "save-failed"
      );
    }
    const tmp = `${path}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      await fs.rename(tmp, path);
    } catch (err) {
      throw new UserOAuthError(
        `Failed to persist refresh token to ${path}: ${(err as Error).message}`,
        "save-failed"
      );
    }
    this.stored = tokens;
    this.storedLoaded = true;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.loadStored();
    return !!stored?.refresh_token;
  }

  async getStatus(): Promise<{
    authenticated: boolean;
    saved_at?: string;
    last_refreshed_at?: string;
    base_url?: string;
    token_age_days?: number;
    days_since_last_refresh?: number;
    user_email?: string;
    token_storage_path: string;
  }> {
    const stored = await this.loadStored();
    if (!stored) {
      return { authenticated: false, token_storage_path: this.config.userTokenPath };
    }
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return {
      authenticated: true,
      saved_at: new Date(stored.saved_at).toISOString(),
      last_refreshed_at: stored.last_refreshed_at
        ? new Date(stored.last_refreshed_at).toISOString()
        : undefined,
      base_url: stored.base_url,
      token_age_days: Math.floor((now - stored.saved_at) / oneDayMs),
      days_since_last_refresh: stored.last_refreshed_at
        ? Math.floor((now - stored.last_refreshed_at) / oneDayMs)
        : undefined,
      user_email: stored.user_email,
      token_storage_path: this.config.userTokenPath
    };
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && Date.now() < this.cachedExpiry - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedAccessToken;
    }
    // Dedupe concurrent refreshes — if 5 requests arrive at once, they all wait
    // on the single in-flight refresh instead of each making a separate exchange.
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return await this.refreshPromise;
  }

  invalidateAccessToken(): void {
    this.cachedAccessToken = null;
    this.cachedExpiry = 0;
  }

  // ── OAuth flows ──────────────────────────────────────────────────────────

  buildAuthorizeUrl(state: string): string {
    if (!this.config.oauthRedirectUri) {
      throw new Error(
        "OAuth redirect URI is not configured. Set PUBLIC_BASE_URL or OAUTH_REDIRECT_URI."
      );
    }
    const url = new URL(this.config.ninjaAuthorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.ninjaClientId);
    url.searchParams.set("redirect_uri", this.config.oauthRedirectUri);
    url.searchParams.set("scope", this.config.oauthScope);
    url.searchParams.set("state", state);
    return url.toString();
  }

  // Browser redirected back with ?code=... — exchange it for tokens and persist
  // the refresh_token. Called by GET /auth/callback.
  async exchangeAuthorizationCode(code: string, userEmailHint?: string): Promise<void> {
    if (!this.config.oauthRedirectUri) {
      throw new UserOAuthError(
        "OAuth redirect URI is not configured. Set PUBLIC_BASE_URL or OAUTH_REDIRECT_URI.",
        "exchange-failed"
      );
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.oauthRedirectUri,
      client_id: this.config.ninjaClientId,
      client_secret: this.config.ninjaClientSecret
    });
    const response = await fetch(this.config.ninjaTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new UserOAuthError(
        `NinjaOne token exchange failed (${response.status}): ${text}`,
        "exchange-failed"
      );
    }
    const data = (await response.json()) as NinjaTokenResponse & {
      refresh_token?: string;
    };
    if (!data.refresh_token) {
      throw new UserOAuthError(
        "NinjaOne returned no refresh_token. Make sure the API app has the 'offline_access' scope enabled and 'Refresh Token' is in allowed grant types.",
        "exchange-failed"
      );
    }
    const now = Date.now();
    await this.saveStored({
      refresh_token: data.refresh_token,
      base_url: this.config.ninjaBaseUrl,
      scope: data.scope ?? this.config.oauthScope,
      saved_at: now,
      last_refreshed_at: now,
      user_email: userEmailHint
    });
    this.cachedAccessToken = data.access_token;
    this.cachedExpiry = now + (data.expires_in ?? 3600) * 1000;
  }

  private async doRefresh(): Promise<string> {
    const stored = await this.loadStored();
    if (!stored?.refresh_token) {
      throw new UserOAuthError(
        `No NinjaOne user-context login on file. ${this.loginInstructions()}`,
        "no-token",
        this.loginUrl()
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: this.config.ninjaClientId,
      client_secret: this.config.ninjaClientSecret
    });
    const response = await fetch(this.config.ninjaTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new UserOAuthError(
        `NinjaOne refresh-token exchange failed (${response.status}): ${text}. ` +
          `The refresh token has expired or been revoked. ${this.loginInstructions()}`,
        "refresh-failed",
        this.loginUrl()
      );
    }

    const data = (await response.json()) as NinjaTokenResponse & {
      refresh_token?: string;
    };
    const now = Date.now();

    // NinjaOne rotates the refresh token on every use. If they return a new one,
    // the OLD one is dead immediately — we must persist the new one BEFORE we
    // return the access token, or a crash before save would lock us out.
    const newRefresh =
      data.refresh_token && data.refresh_token !== stored.refresh_token
        ? data.refresh_token
        : stored.refresh_token;
    const rotated = newRefresh !== stored.refresh_token;

    await this.saveStored({
      ...stored,
      refresh_token: newRefresh,
      scope: data.scope ?? stored.scope,
      last_refreshed_at: now
    });

    if (rotated) {
      console.log(
        `[ninja-oauth] refresh token rotated and persisted at ${new Date(now).toISOString()}`
      );
    }

    this.cachedAccessToken = data.access_token;
    this.cachedExpiry = now + (data.expires_in ?? 3600) * 1000;
    return data.access_token;
  }

  // ── URL & message helpers ────────────────────────────────────────────────

  loginUrl(): string {
    if (!this.config.publicBaseUrl) return "(set PUBLIC_BASE_URL to enable)";
    const secretQS = this.config.mcpSharedSecret
      ? `?token=${encodeURIComponent(this.config.mcpSharedSecret)}`
      : "";
    return `${this.config.publicBaseUrl}/auth/login${secretQS}`;
  }

  loginInstructions(): string {
    const url = this.loginUrl();
    return `Visit ${url} in a browser to sign in to NinjaOne. The sign-in only needs to happen once; the refresh token is then kept alive automatically.`;
  }

  // ── Background keepalive ─────────────────────────────────────────────────

  // Refreshes the token periodically even when idle. Prevents the refresh token
  // from going stale during quiet periods. Logs loudly if a refresh fails so
  // ops can notice before the next real request also fails.
  startKeepalive(intervalMs = 12 * 60 * 60 * 1000): NodeJS.Timeout | null {
    const tick = async () => {
      if (!(await this.isAuthenticated())) return;
      try {
        this.invalidateAccessToken();
        await this.getAccessToken();
        console.log(`[ninja-oauth] keepalive refresh ok at ${new Date().toISOString()}`);
      } catch (err) {
        console.error(
          `[ninja-oauth] KEEPALIVE REFRESH FAILED — user re-login required. ${
            (err as Error).message
          }`
        );
      }
    };
    // Fire-and-forget a tick at startup if we already have a token, so the
    // access token cache is warm.
    void tick();
    return setInterval(() => void tick(), intervalMs);
  }
}
