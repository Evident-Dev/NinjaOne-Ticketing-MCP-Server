// User-context OAuth (Authorization Code + Refresh Token) for NinjaOne.
//
// Why this exists: NinjaOne's ticket-write endpoints (POST /ticketing/ticket,
// PUT, comment) require a user-context token. Client-credentials machine tokens
// get 403 user_context_required. So a real tech must log in once via browser,
// and we persist the refresh_token to use for all subsequent writes.
//
// Each technician has their own NinjaOne sign-in, so tickets and comments are
// authored as the tech whose URL token made the request. Shared-secret (admin)
// requests use a separate shared sign-in kept in a file.
//
// CRITICAL — refresh token rotation:
// NinjaOne issues a NEW refresh_token on every refresh exchange. The old one is
// invalidated immediately. If you fail to persist the new one before returning
// the access token to the caller, the next call breaks irrecoverably. This
// module persists FIRST, then returns the access token. Atomic file writes
// (write-tmp-then-rename) prevent half-written corruption.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { TechnicianDb } from "./db.js";
import { getCurrentRequestContext } from "./request-context.js";
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

// Who a NinjaOne sign-in belongs to. `token` is the tech's personal URL token,
// used to build their own sign-in link.
export type LoginIdentity =
  | { kind: "technician"; email: string; token?: string }
  | { kind: "shared" };

export type UserOAuthErrorKind =
  | "no-token"        // No refresh token stored for this identity
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

// ── Storage ──────────────────────────────────────────────────────────────────

interface TokenStorage {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  describe(): string;
}

class FileTokenStorage implements TokenStorage {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      return JSON.parse(raw) as StoredTokens;
    } catch (error: unknown) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT") {
        console.warn(`Failed to read refresh token from ${this.path}:`, fileError.message);
      }
      return null;
    }
  }

  // Atomic write: writeFile to .tmp, then rename. Prevents partial writes from
  // corrupting the on-disk token in case of crash/power-loss mid-write.
  async save(tokens: StoredTokens): Promise<void> {
    const directory = dirname(this.path);
    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (error) {
      throw new UserOAuthError(
        `Cannot create token directory ${directory}: ${(error as Error).message}. ` +
          `If running on Railway, mount a volume at ${directory} or set USER_TOKEN_PATH to a writable location.`,
        "save-failed"
      );
    }
    const temporaryPath = `${this.path}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      await fs.rename(temporaryPath, this.path);
    } catch (error) {
      throw new UserOAuthError(
        `Failed to persist refresh token to ${this.path}: ${(error as Error).message}`,
        "save-failed"
      );
    }
  }

  describe(): string {
    return this.path;
  }
}

class DatabaseTokenStorage implements TokenStorage {
  constructor(
    private readonly database: TechnicianDb,
    private readonly technicianEmail: string
  ) {}

  async load(): Promise<StoredTokens | null> {
    const row = await this.database.loadNinjaLogin(this.technicianEmail);
    if (!row) return null;
    return {
      refresh_token: row.refresh_token,
      base_url: row.base_url,
      scope: row.scope ?? undefined,
      saved_at: new Date(row.saved_at).getTime(),
      last_refreshed_at: row.last_refreshed_at
        ? new Date(row.last_refreshed_at).getTime()
        : undefined,
      user_email: row.technician_email
    };
  }

  async save(tokens: StoredTokens): Promise<void> {
    try {
      await this.database.saveNinjaLogin({
        technicianEmail: this.technicianEmail,
        refreshToken: tokens.refresh_token,
        baseUrl: tokens.base_url,
        scope: tokens.scope,
        savedAt: new Date(tokens.saved_at),
        lastRefreshedAt: tokens.last_refreshed_at ? new Date(tokens.last_refreshed_at) : undefined
      });
    } catch (error) {
      throw new UserOAuthError(
        `Failed to persist refresh token for ${this.technicianEmail} to Postgres: ${(error as Error).message}`,
        "save-failed"
      );
    }
  }

  describe(): string {
    return `postgres:technician_ninja_logins (${this.technicianEmail})`;
  }
}

// ── One sign-in ──────────────────────────────────────────────────────────────

export interface LoginStatus {
  authenticated: boolean;
  signed_in_for: string;
  saved_at?: string;
  last_refreshed_at?: string;
  base_url?: string;
  token_age_days?: number;
  days_since_last_refresh?: number;
  token_storage: string;
}

export class UserOAuthSession {
  private cachedAccessToken: string | null = null;
  private cachedExpiry = 0;
  private stored: StoredTokens | null = null;
  private storedLoaded = false;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly config: AppConfig,
    readonly identity: LoginIdentity,
    private readonly storage: TokenStorage,
    private readonly loginUrl: () => string
  ) {}

  private async loadStored(): Promise<StoredTokens | null> {
    if (this.storedLoaded) return this.stored;
    this.stored = await this.storage.load();
    this.storedLoaded = true;
    return this.stored;
  }

  private async saveStored(tokens: StoredTokens): Promise<void> {
    await this.storage.save(tokens);
    this.stored = tokens;
    this.storedLoaded = true;
  }

  label(): string {
    return this.identity.kind === "technician" ? this.identity.email : "shared (admin) sign-in";
  }

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.loadStored();
    return !!stored?.refresh_token;
  }

  async getStatus(): Promise<LoginStatus> {
    const stored = await this.loadStored();
    const base = { signed_in_for: this.label(), token_storage: this.storage.describe() };
    if (!stored) return { authenticated: false, ...base };
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return {
      authenticated: true,
      ...base,
      saved_at: new Date(stored.saved_at).toISOString(),
      last_refreshed_at: stored.last_refreshed_at
        ? new Date(stored.last_refreshed_at).toISOString()
        : undefined,
      base_url: stored.base_url,
      token_age_days: Math.floor((now - stored.saved_at) / oneDayMs),
      days_since_last_refresh: stored.last_refreshed_at
        ? Math.floor((now - stored.last_refreshed_at) / oneDayMs)
        : undefined
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

  loginInstructions(): string {
    return `Visit ${this.loginUrl()} in a browser and sign in to NinjaOne as ${this.label()}. The sign-in only needs to happen once; the refresh token is then kept alive automatically.`;
  }

  noLoginError(): UserOAuthError {
    return new UserOAuthError(
      `No NinjaOne sign-in on file for ${this.label()}. Ticket writes need one. ${this.loginInstructions()}`,
      "no-token",
      this.loginUrl()
    );
  }

  // Persist the refresh token from a completed browser sign-in.
  async storeAuthorization(data: NinjaTokenResponse & { refresh_token: string }): Promise<void> {
    const now = Date.now();
    await this.saveStored({
      refresh_token: data.refresh_token,
      base_url: this.config.ninjaBaseUrl,
      scope: data.scope ?? this.config.oauthScope,
      saved_at: now,
      last_refreshed_at: now,
      user_email: this.identity.kind === "technician" ? this.identity.email : undefined
    });
    this.cachedAccessToken = data.access_token;
    this.cachedExpiry = now + (data.expires_in ?? 3600) * 1000;
  }

  private async doRefresh(): Promise<string> {
    const stored = await this.loadStored();
    if (!stored?.refresh_token) throw this.noLoginError();

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
        `NinjaOne refresh-token exchange failed for ${this.label()} (${response.status}): ${text}. ` +
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
        `[ninja-oauth] refresh token rotated and persisted for ${this.label()} at ${new Date(now).toISOString()}`
      );
    }

    this.cachedAccessToken = data.access_token;
    this.cachedExpiry = now + (data.expires_in ?? 3600) * 1000;
    return data.access_token;
  }
}

// ── All sign-ins ─────────────────────────────────────────────────────────────

export class UserOAuth {
  private sessions = new Map<string, UserOAuthSession>();
  // Last personal URL token seen per tech email, for building their sign-in link.
  private technicianTokens = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: TechnicianDb | null
  ) {}

  // Sign-in for whoever made the current request. Technician tokens get their
  // own; shared-secret and open requests get the shared one. Background work
  // with no request gets none.
  currentSession(): UserOAuthSession | null {
    const context = getCurrentRequestContext();
    if (!context) return null;
    if (context.auth.kind === "technician") {
      return this.sessionFor({
        kind: "technician",
        email: context.auth.email,
        token: context.auth.token
      });
    }
    return this.sessionFor({ kind: "shared" });
  }

  sessionFor(identity: LoginIdentity): UserOAuthSession {
    if (identity.kind === "technician" && identity.token) {
      this.technicianTokens.set(identity.email.toLowerCase(), identity.token);
    }
    const key = identity.kind === "technician" ? `technician:${identity.email.toLowerCase()}` : "shared";
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const session = new UserOAuthSession(
      this.config,
      identity,
      this.storageFor(identity),
      () => this.loginUrl(identity)
    );
    this.sessions.set(key, session);
    return session;
  }

  private storageFor(identity: LoginIdentity): TokenStorage {
    if (identity.kind === "shared") return new FileTokenStorage(this.config.userTokenPath);
    if (this.database) return new DatabaseTokenStorage(this.database, identity.email);
    // No database: one file per tech next to the shared one.
    const safeEmail = identity.email.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
    return new FileTokenStorage(
      join(dirname(this.config.userTokenPath), `refresh-token.${safeEmail}.json`)
    );
  }

  loginUrl(identity: LoginIdentity): string {
    if (!this.config.publicBaseUrl) return "(set PUBLIC_BASE_URL to enable)";
    const base = `${this.config.publicBaseUrl}/auth/login`;
    if (identity.kind === "technician") {
      const token =
        identity.token ??
        this.technicianTokens.get(identity.email.toLowerCase()) ??
        "<your-personal-token>";
      return `${base}?token=${encodeURIComponent(token)}`;
    }
    return this.config.mcpSharedSecret
      ? `${base}?token=${encodeURIComponent(this.config.mcpSharedSecret)}`
      : base;
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

  // Browser redirected back with ?code=... — exchange it for tokens and store
  // the refresh_token under the identity that started the sign-in.
  async exchangeAuthorizationCode(code: string, identity: LoginIdentity): Promise<UserOAuthSession> {
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
    const refreshToken = data.refresh_token;
    if (!refreshToken) {
      throw new UserOAuthError(
        "NinjaOne returned no refresh_token. Make sure the API app has the 'offline_access' scope enabled and 'Refresh Token' is in allowed grant types.",
        "exchange-failed"
      );
    }
    const session = this.sessionFor(identity);
    await session.storeAuthorization({ ...data, refresh_token: refreshToken });
    return session;
  }

  // ── Background keepalive ─────────────────────────────────────────────────

  // Refreshes every stored sign-in periodically even when idle. Prevents the
  // refresh tokens from going stale during quiet periods. Logs loudly if a
  // refresh fails so ops can notice before the next real request also fails.
  startKeepalive(
    listTechnicianEmails: () => string[],
    intervalMs = 12 * 60 * 60 * 1000
  ): NodeJS.Timeout {
    const refreshSession = async (session: UserOAuthSession) => {
      try {
        if (!(await session.isAuthenticated())) return;
        session.invalidateAccessToken();
        await session.getAccessToken();
        console.log(
          `[ninja-oauth] keepalive refresh ok for ${session.label()} at ${new Date().toISOString()}`
        );
      } catch (error) {
        console.error(
          `[ninja-oauth] KEEPALIVE REFRESH FAILED for ${session.label()} — re-login required. ${
            (error as Error).message
          }`
        );
      }
    };
    const tick = async () => {
      const emails = this.database
        ? await this.database.listNinjaLoginEmails().catch((error: Error) => {
            console.error(`[ninja-oauth] couldn't list technician sign-ins: ${error.message}`);
            return [] as string[];
          })
        : listTechnicianEmails();
      const sessions = [
        this.sessionFor({ kind: "shared" }),
        ...emails.map((email) => this.sessionFor({ kind: "technician", email }))
      ];
      for (const session of sessions) await refreshSession(session);
    };
    // Fire-and-forget a tick at startup so the access token caches are warm.
    void tick();
    return setInterval(() => void tick(), intervalMs);
  }
}
