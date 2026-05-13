import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionUser {
  appUserId?: number;
  email?: string;
  displayName?: string;
}

export interface Session {
  mcp_access_token: string;
  mcp_refresh_token: string;
  mcp_access_token_expires_at: number;
  ninja_refresh_token: string;
  ninja_access_token?: string;
  ninja_access_token_expires_at?: number;
  user?: SessionUser;
  scope: string;
  client_id: string;
  created_at: number;
  last_used_at: number;
}

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  created_at: number;
}

export interface PendingAuth {
  ninja_state: string;
  claude_state?: string;
  claude_redirect_uri: string;
  claude_client_id: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope: string;
  created_at: number;
}

export interface PendingCode {
  code: string;
  ninja_refresh_token: string;
  ninja_access_token: string;
  ninja_access_token_expires_at: number;
  user?: SessionUser;
  scope: string;
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  created_at: number;
}

interface StoreData {
  sessions: Session[];
  clients: RegisteredClient[];
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export class SessionStore {
  private cache: StoreData = { sessions: [], clients: [] };
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  // In-memory only — short-lived during the OAuth dance.
  private pendingAuths = new Map<string, PendingAuth>();
  private pendingCodes = new Map<string, PendingCode>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      this.cache = JSON.parse(raw) as StoreData;
      if (!Array.isArray(this.cache.sessions)) this.cache.sessions = [];
      if (!Array.isArray(this.cache.clients)) this.cache.clients = [];
    } catch (error: unknown) {
      if (isNoEnt(error)) this.cache = { sessions: [], clients: [] };
      else throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    // Serialize writes to avoid corruption.
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((r) => (release = r));
    try {
      await prev;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    } finally {
      release();
    }
  }

  async getSessionByAccessToken(token: string): Promise<Session | undefined> {
    await this.load();
    return this.cache.sessions.find((s) => s.mcp_access_token === token);
  }

  async getSessionByRefreshToken(token: string): Promise<Session | undefined> {
    await this.load();
    return this.cache.sessions.find((s) => s.mcp_refresh_token === token);
  }

  async putSession(session: Session): Promise<void> {
    await this.load();
    const idx = this.cache.sessions.findIndex(
      (s) => s.mcp_refresh_token === session.mcp_refresh_token
    );
    if (idx >= 0) this.cache.sessions[idx] = session;
    else this.cache.sessions.push(session);
    await this.save();
  }

  async deleteSessionByAccessToken(token: string): Promise<void> {
    await this.load();
    const before = this.cache.sessions.length;
    this.cache.sessions = this.cache.sessions.filter((s) => s.mcp_access_token !== token);
    if (this.cache.sessions.length !== before) await this.save();
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    await this.load();
    return this.cache.clients.find((c) => c.client_id === clientId);
  }

  async putClient(client: RegisteredClient): Promise<void> {
    await this.load();
    this.cache.clients.push(client);
    await this.save();
  }

  putPendingAuth(state: string, auth: PendingAuth): void {
    this.gcPending();
    this.pendingAuths.set(state, auth);
  }

  takePendingAuth(state: string): PendingAuth | undefined {
    this.gcPending();
    const found = this.pendingAuths.get(state);
    if (found) this.pendingAuths.delete(state);
    return found;
  }

  putPendingCode(code: string, data: PendingCode): void {
    this.gcPending();
    this.pendingCodes.set(code, data);
  }

  takePendingCode(code: string): PendingCode | undefined {
    this.gcPending();
    const found = this.pendingCodes.get(code);
    if (found) this.pendingCodes.delete(code);
    return found;
  }

  private gcPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of this.pendingAuths) if (v.created_at < cutoff) this.pendingAuths.delete(k);
    for (const [k, v] of this.pendingCodes) if (v.created_at < cutoff) this.pendingCodes.delete(k);
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function isNoEnt(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
