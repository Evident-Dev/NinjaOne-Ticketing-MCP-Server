// Postgres connection + schema bootstrap + technician CRUD.
//
// Railway auto-injects DATABASE_URL when you attach a Postgres plugin to the
// service. If DATABASE_URL isn't set, we don't try to connect — callers
// (technician-store) fall back to the env-var allowlist.

import pg from "pg";
const { Pool } = pg;

export interface TechnicianRow {
  id: number;
  ninja_user_id: number;
  email: string;
  name: string | null;
  token: string;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
}

export class TechnicianDb {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Railway managed Postgres uses TLS but the cert isn't always in Node's
      // default trust store. Allowing self-signed inside the Railway private
      // network is acceptable — DATABASE_URL itself is the secret.
      ssl:
        connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
          ? false
          : { rejectUnauthorized: false }
    });
    this.pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }

  // Idempotent — safe to call on every boot.
  async bootstrapSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS technicians (
        id            SERIAL PRIMARY KEY,
        ninja_user_id INTEGER NOT NULL UNIQUE,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT,
        token         TEXT NOT NULL UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_technicians_token ON technicians(token);
      CREATE INDEX IF NOT EXISTS idx_technicians_email ON technicians(email);

      CREATE TABLE IF NOT EXISTS audit_log (
        id              BIGSERIAL PRIMARY KEY,
        ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_email     TEXT,
        actor_source    TEXT,
        method          TEXT NOT NULL,
        path            TEXT NOT NULL,
        status_code     INTEGER,
        result_code     TEXT,
        payload_summary TEXT,
        error_message   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_email);
    `);
  }

  async writeAudit(entry: {
    actorEmail?: string;
    actorSource?: string;
    method: string;
    path: string;
    statusCode?: number;
    resultCode?: string;
    payloadSummary?: string;
    errorMessage?: string;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_log
           (actor_email, actor_source, method, path, status_code, result_code, payload_summary, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.actorEmail ?? null,
          entry.actorSource ?? null,
          entry.method,
          entry.path,
          entry.statusCode ?? null,
          entry.resultCode ?? null,
          entry.payloadSummary ?? null,
          entry.errorMessage ?? null
        ]
      );
    } catch (err) {
      // Audit must never break the actual request.
      console.warn("[audit] failed to record:", (err as Error).message);
    }
  }

  async recentAudit(limit = 25): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT id, ts, actor_email, actor_source, method, path, status_code, result_code,
              payload_summary, error_message
       FROM audit_log
       ORDER BY id DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)]
    );
    return res.rows;
  }

  // Insert a row only if the ninja_user_id isn't already present. Returns true
  // if a new row was inserted, false if the user already had a row.
  async insertIfNew(
    ninjaUserId: number,
    email: string,
    name: string | null,
    token: string
  ): Promise<boolean> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO technicians (ninja_user_id, email, name, token, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ninja_user_id) DO UPDATE
         SET last_seen_at = NOW(),
             email = EXCLUDED.email,
             name = EXCLUDED.name
       RETURNING id, (xmax = 0) AS inserted`,
      [ninjaUserId, email.toLowerCase(), name, token]
    );
    // xmax=0 means the row was just inserted (not updated). pg returns it as a
    // boolean. We exposed it as `inserted` in the SELECT list.
    const row = result.rows[0] as { id: number; inserted: boolean };
    return row.inserted;
  }

  async listAll(): Promise<TechnicianRow[]> {
    const result = await this.pool.query<TechnicianRow>(
      `SELECT id, ninja_user_id, email, name, token, created_at, updated_at, last_seen_at
       FROM technicians
       ORDER BY id`
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
