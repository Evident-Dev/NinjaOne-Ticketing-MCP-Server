// Single source of truth for "which tokens does the server accept, and which
// NinjaOne user does each one map to."
//
// Two modes:
//   DB mode  — DATABASE_URL is set. Sync from NinjaOne /users on boot, every
//              15 minutes, and on token-miss. Auto-generates new tokens for
//              new technicians. Cache in memory for fast auth.
//   Env mode — NINJA_TECHNICIANS env var (legacy / DB-less). Static list.
//
// In either mode the public API is the same: `find(token)` returns a
// TechnicianEntry or undefined.

import { randomBytes } from "node:crypto";
import type { AppConfig, TechnicianEntry } from "./config.js";
import type { TechnicianDb } from "./db.js";
import type { NinjaClient } from "./ninja.js";
import type { NinjaUser } from "./types.js";

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_MIN_GAP_MS = 30 * 1000; // never refresh more often than this

interface SyncResult {
  total: number;
  inserted: number;
  source: "db" | "env" | "none";
}

export class TechnicianStore {
  private byToken = new Map<string, TechnicianEntry>();
  private lastSyncedAt = 0;
  private syncPromise: Promise<SyncResult> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: TechnicianDb | null,
    private readonly ninja: NinjaClient
  ) {}

  /** Initial load + start the periodic re-sync timer. */
  async initialize(): Promise<SyncResult> {
    const result = await this.sync();
    if (this.db) {
      setInterval(() => {
        void this.sync().catch((err) =>
          console.error("[tech-store] periodic sync failed:", (err as Error).message)
        );
      }, SYNC_INTERVAL_MS);
    }
    return result;
  }

  /** Fast lookup used by the /mcp auth middleware. Returns the matched
   *  technician or undefined. */
  find(token: string): TechnicianEntry | undefined {
    return this.byToken.get(token);
  }

  size(): number {
    return this.byToken.size;
  }

  emails(): string[] {
    return [...this.byToken.values()].map((t) => t.email);
  }

  /** Re-syncs from NinjaOne + DB (or env-var) into the in-memory cache. Used
   *  by the boot path, the periodic timer, and the auth middleware's
   *  "refresh-on-miss" path. Deduped — only one in-flight sync at a time. */
  async sync(): Promise<SyncResult> {
    if (this.syncPromise) return this.syncPromise;
    if (Date.now() - this.lastSyncedAt < SYNC_MIN_GAP_MS) {
      // Too soon since last sync — return the cache state without hitting
      // NinjaOne again.
      return { total: this.byToken.size, inserted: 0, source: this.modeName() };
    }
    this.syncPromise = this.doSync().finally(() => {
      this.lastSyncedAt = Date.now();
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  /** Called by the auth middleware when an unknown token is presented. Re-syncs
   *  (subject to the min-gap) and re-checks. Lets newly-added techs work
   *  immediately without waiting for the periodic refresh. */
  async findWithRefresh(token: string): Promise<TechnicianEntry | undefined> {
    const hit = this.find(token);
    if (hit) return hit;
    await this.sync();
    return this.find(token);
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async doSync(): Promise<SyncResult> {
    if (this.db) {
      return this.syncFromDb();
    }
    if (this.config.technicians.length > 0) {
      return this.loadFromEnv();
    }
    this.byToken.clear();
    return { total: 0, inserted: 0, source: "none" };
  }

  private async syncFromDb(): Promise<SyncResult> {
    const db = this.db!;
    let inserted = 0;

    // 1. Pull current technicians from NinjaOne.
    let users: NinjaUser[] = [];
    try {
      users = await this.ninja.listTechnicianUsers();
    } catch (err) {
      console.warn(
        `[tech-store] couldn't fetch NinjaOne users (${(err as Error).message}). Keeping existing DB rows.`
      );
    }

    // 2. Upsert each into the DB. New ones get a freshly generated token.
    for (const u of users) {
      if (!u.email) continue;
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || null;
      const newToken = generateToken();
      const didInsert = await db.insertIfNew(u.id, u.email, name, newToken);
      if (didInsert) {
        inserted += 1;
        console.log(`[tech-store] new technician registered: ${u.email} (NinjaOne user ${u.id})`);
      }
    }

    // 3. Reload the entire allowlist from the DB into the in-memory cache.
    const rows = await db.listAll();
    this.byToken.clear();
    for (const row of rows) {
      this.byToken.set(row.token, {
        email: row.email,
        token: row.token,
        name: row.name ?? undefined
      });
    }

    return { total: this.byToken.size, inserted, source: "db" };
  }

  private loadFromEnv(): SyncResult {
    this.byToken.clear();
    for (const t of this.config.technicians) {
      this.byToken.set(t.token, t);
    }
    return { total: this.byToken.size, inserted: 0, source: "env" };
  }

  private modeName(): "db" | "env" | "none" {
    if (this.db) return "db";
    if (this.config.technicians.length > 0) return "env";
    return "none";
  }
}

function generateToken(): string {
  return randomBytes(24).toString("hex");
}
