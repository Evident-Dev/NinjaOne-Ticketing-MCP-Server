import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMissingVars, loadConfig } from "./config.js";
import { NinjaApiError, NinjaClient } from "./ninja.js";
import { buildAuthRoutes } from "./auth-routes.js";
import { UserOAuthError } from "./user-oauth.js";
import { withRequestContext, type AuthMode } from "./request-context.js";
import { TechnicianDb } from "./db.js";
import { TechnicianStore } from "./technician-store.js";
import { registerStatusDomain } from "./domains/status.js";
import { registerLookupDomain } from "./domains/lookup.js";
import { registerTicketsDomain } from "./domains/tickets.js";
import { registerCustomersDomain } from "./domains/customers.js";
import { registerDevicesDomain } from "./domains/devices.js";
import { registerAlertsDomain } from "./domains/alerts.js";
import type { DomainRegister } from "./domains/common.js";

const SERVER_VERSION = "0.8.0";

const config = loadConfig();
const ninja = new NinjaClient(config);
const technicianDb = config.databaseUrl ? new TechnicianDb(config.databaseUrl) : null;
const technicianStore = new TechnicianStore(config, technicianDb, ninja);

// Slice = the set of domain registers that get attached to an MCP endpoint.
// Status tools are included in every slice so clients can always introspect
// the connection.
type SliceName = "tickets" | "customers" | "devices" | "alerts" | "full";

// Lookup (find_organizations / find_org_by_domain / find_contact / etc.) is
// included on EVERY slice — almost every workflow needs to resolve "the customer
// the user mentioned by name" into an organization_id. Five small read-only
// tools, cheap to ship everywhere.
const SLICES: Record<SliceName, DomainRegister[]> = {
  tickets: [registerStatusDomain, registerLookupDomain, registerTicketsDomain],
  customers: [registerStatusDomain, registerLookupDomain, registerCustomersDomain],
  devices: [registerStatusDomain, registerLookupDomain, registerDevicesDomain],
  alerts: [registerStatusDomain, registerLookupDomain, registerAlertsDomain],
  full: [
    registerStatusDomain,
    registerLookupDomain,
    registerTicketsDomain,
    registerCustomersDomain,
    registerDevicesDomain,
    registerAlertsDomain
  ]
};

function buildServer(slice: SliceName): McpServer {
  const server = new McpServer({
    name: `ninja-mcp-${slice}`,
    version: SERVER_VERSION
  });
  for (const register of SLICES[slice]) {
    register({ server, ninja, config });
  }
  return server;
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  const missing = getMissingVars();
  res.json({
    ok: true,
    configured: missing.length === 0,
    missing,
    service: "ninja-ticket-mcp-server",
    version: SERVER_VERSION,
    region: config.ninjaRegion,
    endpoints: ["/mcp", "/mcp/tickets", "/mcp/customers", "/mcp/devices", "/mcp/alerts"]
  });
});

app.get("/debug/test-ninja", requireSharedSecret, requireConfigured, async (_req, res, next) => {
  try {
    res.json(await ninja.testConnection());
  } catch (error) {
    next(error);
  }
});

// ── User-OAuth routes (one-time browser login to bootstrap ticket writes) ────

const authRoutes = buildAuthRoutes(config, ninja.userOAuth);
app.get("/auth/login", authRoutes.requireSharedSecret, requireConfigured, authRoutes.handleLogin);
app.get("/auth/callback", requireConfigured, authRoutes.handleCallback);
app.get("/auth/status", authRoutes.requireSharedSecret, requireConfigured, authRoutes.handleStatus);

// Mount one MCP endpoint per slice. Each endpoint exposes only the tools its
// slice covers — clients add whichever URL matches their workflow.
mountMcpEndpoint("/mcp", "full");
mountMcpEndpoint("/mcp/tickets", "tickets");
mountMcpEndpoint("/mcp/customers", "customers");
mountMcpEndpoint("/mcp/devices", "devices");
mountMcpEndpoint("/mcp/alerts", "alerts");

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Request failed:", error);
  if (res.headersSent) return;
  if (error instanceof UserOAuthError) {
    res.status(error.kind === "no-token" ? 401 : 500).json({
      ok: false,
      error: error.message,
      login_url: error.loginUrl,
      kind: error.kind
    });
    return;
  }
  const message =
    error instanceof NinjaApiError || error instanceof Error
      ? error.message
      : "Unknown error";
  res.status(500).json({ ok: false, error: message });
});

app.listen(config.port, async () => {
  console.log(
    `NinjaOne MCP server v${SERVER_VERSION} listening on :${config.port} (region: ${config.ninjaRegion})`
  );
  console.log(`Endpoints: /mcp, /mcp/tickets, /mcp/customers, /mcp/devices, /mcp/alerts`);

  const missing = getMissingVars();
  if (missing.length > 0) {
    console.error("");
    console.error("============================================================");
    console.error("  CONFIGURATION INCOMPLETE — server is running but unusable");
    console.error("============================================================");
    console.error("  Missing required variable(s):");
    for (const name of missing) console.error(`    - ${name}`);
    console.error("");
    console.error("  Fix: open this service in Railway → Variables tab,");
    console.error("       add the variable(s) above, then redeploy.");
    console.error("  See README → Setup for where to find the values.");
    console.error("============================================================");
    console.error("");
    return;
  }

  // Bootstrap the technician store. In DB mode this:
  //   - opens the Postgres connection (DATABASE_URL)
  //   - runs CREATE TABLE IF NOT EXISTS
  //   - syncs from NinjaOne /users → DB (new techs get auto-generated tokens)
  //   - loads all tokens into the in-memory cache for fast auth
  //   - starts the 15-minute periodic re-sync
  if (technicianDb) {
    try {
      await technicianDb.bootstrapSchema();
      console.log("[tech-store] DB schema ready (table: technicians)");
    } catch (err) {
      console.error("[tech-store] schema bootstrap FAILED:", (err as Error).message);
    }
  }
  try {
    const result = await technicianStore.initialize();
    if (result.source === "db") {
      console.log(
        `[tech-store] DB mode: ${result.total} technician(s) registered, ${result.inserted} new`
      );
      if (result.inserted > 0) {
        console.log("[tech-store] view the new tokens in Railway → Postgres → Data → technicians");
      }
    } else if (result.source === "env") {
      console.log(`[tech-store] env-var mode: ${result.total} technician(s) registered`);
    }
  } catch (err) {
    console.error("[tech-store] initialization failed:", (err as Error).message);
  }

  if (!config.mcpSharedSecret && technicianStore.size() === 0) {
    console.warn("");
    console.warn("WARNING: No MCP_SHARED_SECRET, no DATABASE_URL, no NINJA_TECHNICIANS.");
    console.warn("/mcp endpoints are UNAUTHENTICATED. Fine for local dev, NOT for prod.");
    console.warn("");
  }

  if (!config.publicBaseUrl) {
    console.warn("");
    console.warn("WARNING: PUBLIC_BASE_URL is not set and Railway didn't expose");
    console.warn("RAILWAY_PUBLIC_DOMAIN. Browser sign-in URLs cannot be generated.");
    console.warn("Generate a public domain in Railway → Settings → Networking.");
    console.warn("");
  }

  // Status of user-context auth — loud banner if not signed in yet.
  const authed = await ninja.userOAuth.isAuthenticated();
  if (!authed) {
    console.warn("");
    console.warn("============================================================");
    console.warn("  NinjaOne USER LOGIN REQUIRED for ticket writes");
    console.warn("============================================================");
    console.warn("  Reads (orgs, devices, alerts) work now via machine token.");
    console.warn("  Ticket writes (create, update, comment) need a one-time");
    console.warn("  browser sign-in. Open this URL in a browser:");
    console.warn("");
    console.warn(`    ${ninja.userOAuth.loginUrl()}`);
    console.warn("");
    console.warn("  After sign-in the refresh token persists at:");
    console.warn(`    ${config.userTokenPath}`);
    console.warn("  Mount a Railway Volume at /data so it survives redeploys.");
    console.warn("============================================================");
    console.warn("");
  } else {
    const status = await ninja.userOAuth.getStatus();
    console.log(
      `[ninja-oauth] user-context token loaded (saved ${status.token_age_days}d ago, last refreshed ${
        status.days_since_last_refresh ?? "?"
      }d ago)`
    );
  }

  // Background keepalive: refresh the user token every 12 hours so the refresh
  // chain stays warm during quiet periods.
  ninja.userOAuth.startKeepalive();
});

// ── Endpoint wiring ──────────────────────────────────────────────────────────

function mountMcpEndpoint(path: string, slice: SliceName): void {
  app.post(path, requireMcpAuth, requireConfigured, async (req, res) => {
    // Resolve auth mode from request — set by requireMcpAuth middleware.
    const auth: AuthMode = (req as Request & { mcpAuth?: AuthMode }).mcpAuth ?? { kind: "open" };

    // Fresh server + transport per request. Stateless. Avoids any cross-request
    // session bookkeeping.
    const server = buildServer(slice);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await withRequestContext({ auth }, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      console.error(`MCP request failed at ${path}:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error"
          }
        });
      }
    }
  });
}

// ── Middleware ───────────────────────────────────────────────────────────────

function requireConfigured(_req: Request, res: Response, next: NextFunction): void {
  const missing = getMissingVars();
  if (missing.length > 0) {
    res.status(503).json({
      ok: false,
      error: `Missing required environment variable(s): ${missing.join(", ")}. Add to Railway → Variables and redeploy.`,
      missing,
      fix: "Open the Railway service → Variables tab → add the variable(s) above → redeploy. See README for where to find each value."
    });
    return;
  }
  next();
}

function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  // If no secret is configured, the endpoint is open (local dev mode).
  if (!config.mcpSharedSecret) {
    next();
    return;
  }
  const headerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  if (headerToken !== config.mcpSharedSecret && queryToken !== config.mcpSharedSecret) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="MCP"`)
      .json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

// /mcp/* auth. Accepts:
//   1. A per-technician token matching a row in the `technicians` DB table
//      (or NINJA_TECHNICIANS env var if no DATABASE_URL). Resolves to that
//      tech's identity for assignment + comment signing.
//   2. The MCP_SHARED_SECRET — admin/fallback access, no per-request identity.
//
// If neither tech-store nor MCP_SHARED_SECRET is configured, the endpoint is
// open (local dev only).
//
// On unknown token: triggers a re-sync from NinjaOne before giving up — so a
// freshly-added tech can use their token immediately without waiting for the
// next periodic refresh.
async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const presented = headerToken ?? queryToken;

  if (presented) {
    const tech = await technicianStore.findWithRefresh(presented);
    if (tech) {
      (req as Request & { mcpAuth?: AuthMode }).mcpAuth = {
        kind: "technician",
        email: tech.email,
        name: tech.name
      };
      next();
      return;
    }

    if (config.mcpSharedSecret && presented === config.mcpSharedSecret) {
      (req as Request & { mcpAuth?: AuthMode }).mcpAuth = { kind: "shared-secret" };
      next();
      return;
    }
  }

  // Local dev: no auth configured at all.
  if (!config.mcpSharedSecret && technicianStore.size() === 0) {
    (req as Request & { mcpAuth?: AuthMode }).mcpAuth = { kind: "open" };
    next();
    return;
  }

  res
    .status(401)
    .set("WWW-Authenticate", `Bearer realm="MCP"`)
    .json({
      ok: false,
      error:
        "Unauthorized. Append ?token=<your-personal-token> to the URL, or send Authorization: Bearer <token>.",
      hint:
        technicianStore.size() > 0
          ? "This server has per-technician tokens. Ask your admin for your personal token (visible in the Railway DB browser)."
          : "This server is configured with a shared secret. The presented token doesn't match."
    });
}
