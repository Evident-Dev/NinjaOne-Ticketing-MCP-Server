import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMissingVars, loadConfig } from "./config.js";
import { NinjaApiError, NinjaClient } from "./ninja.js";
import { buildAuthRoutes } from "./auth-routes.js";
import { UserOAuthError } from "./user-oauth.js";
import { registerStatusDomain } from "./domains/status.js";
import { registerTicketsDomain } from "./domains/tickets.js";
import { registerCustomersDomain } from "./domains/customers.js";
import { registerDevicesDomain } from "./domains/devices.js";
import { registerAlertsDomain } from "./domains/alerts.js";
import type { DomainRegister } from "./domains/common.js";

const SERVER_VERSION = "0.5.2";

const config = loadConfig();
const ninja = new NinjaClient(config);

// Slice = the set of domain registers that get attached to an MCP endpoint.
// Status tools are included in every slice so clients can always introspect
// the connection.
type SliceName = "tickets" | "customers" | "devices" | "alerts" | "full";

const SLICES: Record<SliceName, DomainRegister[]> = {
  tickets: [registerStatusDomain, registerTicketsDomain],
  customers: [registerStatusDomain, registerCustomersDomain],
  devices: [registerStatusDomain, registerDevicesDomain],
  alerts: [registerStatusDomain, registerAlertsDomain],
  full: [
    registerStatusDomain,
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

  if (!config.mcpSharedSecret) {
    console.warn("");
    console.warn("WARNING: MCP_SHARED_SECRET is not set — /mcp endpoints are");
    console.warn("UNAUTHENTICATED. Fine for local dev, NOT safe for production.");
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
  app.post(path, requireSharedSecret, requireConfigured, async (req, res) => {
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
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
