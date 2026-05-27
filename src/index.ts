import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMissingVars, loadConfig } from "./config.js";
import { NinjaApiError, NinjaClient } from "./ninja.js";
import { registerStatusDomain } from "./domains/status.js";
import { registerTicketsDomain } from "./domains/tickets.js";
import { registerCustomersDomain } from "./domains/customers.js";
import { registerDevicesDomain } from "./domains/devices.js";
import { registerAlertsDomain } from "./domains/alerts.js";
import type { DomainRegister } from "./domains/common.js";

const SERVER_VERSION = "0.4.0";

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
  const message =
    error instanceof NinjaApiError || error instanceof Error
      ? error.message
      : "Unknown error";
  res.status(500).json({ ok: false, error: message });
});

app.listen(config.port, () => {
  console.log(
    `NinjaOne MCP server v${SERVER_VERSION} listening on :${config.port} (region: ${config.ninjaRegion})`
  );
  console.log(`Endpoints: /mcp, /mcp/tickets, /mcp/customers, /mcp/devices, /mcp/alerts`);
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
      error: "Server is not fully configured. Set these env vars and redeploy.",
      missing
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
