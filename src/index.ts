import { AsyncLocalStorage } from "node:async_hooks";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getMissingVars, loadConfig } from "./config.js";
import { NinjaClient } from "./ninja.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  loginUrl,
  StateCache,
  TokenStore
} from "./auth.js";
import { SessionStore, type Session } from "./sessions.js";
import {
  discoveryDoc,
  handleAuthorize,
  handleNinjaCallbackForMcp,
  handleRegister,
  handleToken,
  protectedResourceDoc
} from "./oauth-server.js";

const config = loadConfig();
const tokenStore = new TokenStore(config.tokenStorePath);
const sessionStore = new SessionStore(config.sessionStorePath);
const stateCache = new StateCache();
const sessionContext = new AsyncLocalStorage<Session | undefined>();
const ninja = new NinjaClient(config, tokenStore, sessionStore, sessionContext);

const server = new McpServer({
  name: "ninja-ticket-mcp-server",
  version: "0.3.0"
});

// ── Read-only lookup tools ────────────────────────────────────────────────────

server.registerTool(
  "ninja_find_organizations",
  {
    title: "Find NinjaOne Organizations",
    description: "Search NinjaOne organizations by name and return matching organization IDs. Use this when you know (part of) the client name. Read-only.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Client or organization name to search for"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max orgs to return")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ query, limit }) => {
    const matches = await ninja.findOrganizations(query, limit);
    return jsonResult({ count: matches.length, organizations: matches.map((org) => ({ id: org.id, name: org.name })) });
  }
);

server.registerTool(
  "ninja_find_org_by_domain",
  {
    title: "Find NinjaOne Organization by Email Domain",
    description: `Find a NinjaOne organization by email domain (e.g. "acme.com"). Works by matching the domain against contacts registered in NinjaOne. Use this when you have an email address and need to identify the client organization.`,
    inputSchema: z.object({
      domain: z.string().min(3).describe("Email domain to look up, e.g. acme.com or john@acme.com — the @ and everything before it is ignored")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ domain }) => {
    const bare = domain.includes("@") ? domain.split("@")[1] : domain;
    const orgs = await ninja.findOrgsByDomain(bare);
    if (orgs.length === 0) return jsonResult({ found: false, domain: bare, organizations: [] });
    return jsonResult({ found: true, domain: bare, organizations: orgs.map((o) => ({ id: o.id, name: o.name })) });
  }
);

server.registerTool(
  "ninja_find_contact",
  {
    title: "Find NinjaOne Contact",
    description: `Search NinjaOne contacts by name or email address. Returns the contact's uid (needed as requester_uid when creating a ticket) and their organization (clientId). Use this to look up who filed a request or to set a requester on a ticket.`,
    inputSchema: z.object({
      query: z.string().min(2).describe("Name, email address, or partial email to search for")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ query }) => {
    const contacts = await ninja.findContactsByQuery(query);
    return jsonResult({
      count: contacts.length,
      contacts: contacts.map((c) => ({
        uid: c.uid,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
        email: c.email ?? null,
        organization_id: c.clientId
      }))
    });
  }
);

server.registerTool(
  "ninja_list_ticket_forms",
  {
    title: "List NinjaOne Ticket Forms",
    description: "Return NinjaOne ticket forms so you can choose a form ID. Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => jsonResult(await ninja.listTicketForms())
);

server.registerTool(
  "ninja_list_ticket_boards",
  {
    title: "List NinjaOne Ticket Boards",
    description: "Return NinjaOne ticket boards so you can choose a board ID. Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => jsonResult(await ninja.listTicketBoards())
);

server.registerTool(
  "ninja_auth_status",
  {
    title: "NinjaOne User Auth Status",
    description: "Check whether the MCP server has a user-context NinjaOne token (required for creating/updating tickets and adding comments). If not authenticated, returns a login_url to share with the user so they can connect their NinjaOne account.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    const authed = await ninja.hasUserAuth();
    return jsonResult({
      authenticated: authed,
      login_url: loginUrl(config),
      message: authed
        ? "User-scoped NinjaOne token is active. Write operations should work."
        : "No user-scoped NinjaOne token on file. Reads work; writes will fail. Visit login_url in a browser to connect."
    });
  }
);

server.registerTool(
  "ninja_whoami",
  {
    title: "NinjaOne Technician Identity",
    description: "Returns the NinjaOne technician profile this server is configured to act as (set via TECHNICIAN_EMAIL). Use this to confirm whose name will appear on tickets and comments, or to check if technician attribution is configured.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    const profile = await ninja.getTechnicianProfile();
    if (!profile) {
      return jsonResult({ configured: false, message: "TECHNICIAN_EMAIL is not set. Tickets will not be auto-assigned and comments will not be signed." });
    }
    return jsonResult({ configured: true, display_name: profile.displayName, email: profile.email, ninja_user_id: profile.appUserId });
  }
);

server.registerTool(
  "ninja_list_ticket_statuses",
  {
    title: "List NinjaOne Ticket Statuses",
    description: "Return the configured ticket statuses for this NinjaOne tenant. Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => jsonResult(await ninja.listTicketStatuses())
);

server.registerTool(
  "ninja_get_ticket",
  {
    title: "Get NinjaOne Ticket",
    description: "Retrieve a NinjaOne ticket by its numeric ID. Returns the full ticket object including status, priority, assignee, and description.",
    inputSchema: z.object({
      ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ ticket_id }) => jsonResult(await ninja.getTicket(ticket_id))
);

// ── Write tools ───────────────────────────────────────────────────────────────

server.registerTool(
  "ninja_create_ticket",
  {
    title: "Create NinjaOne Ticket",
    description: `Create a NinjaOne support ticket for a client organization.

Org resolution order (use whichever you have):
1. organization_id — exact numeric ID, most reliable
2. organization_domain — e.g. "acme.com"; resolved via contacts (call ninja_find_org_by_domain first if unsure)
3. organization_name — fuzzy matched; will error if ambiguous

If you have an email address for the requester, pass it as requester_email and the server will look up their contact UID automatically.

This tool only creates the ticket. It does not run scripts, access devices, or change configurations.`,
    inputSchema: z.object({
      organization_name: z.string().min(2).optional().describe("NinjaOne organization/client name (fuzzy matched)"),
      organization_id: z.coerce.number().int().positive().optional().describe("Exact NinjaOne organization ID"),
      organization_domain: z.string().min(3).optional().describe("Email domain of the client, e.g. acme.com"),
      summary: z.string().min(3).max(200).describe("Ticket subject / one-line summary"),
      description: z.string().min(3).max(10000).describe("Full ticket details"),
      type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional().describe("Ticket type: PROBLEM (something is broken), QUESTION (information needed), INCIDENT (ongoing outage/impact), TASK (planned work)"),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional().describe("Ticket priority"),
      severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional().describe("Impact severity"),
      status: z.string().optional().describe("Initial status — accepts symbolic name (NEW, OPEN, WAITING, PAUSED, RESOLVED, CLOSED) or numeric statusId. Defaults to NEW."),
      requester_email: z.string().email().optional().describe("Email of the person requesting support — looked up in NinjaOne contacts to set requester"),
      assigned_app_user_id: z.coerce.number().int().positive().optional().describe("Technician user ID to assign the ticket to (overrides default technician)"),
      form_id: z.coerce.number().int().positive().optional().describe("Ticket form ID (use ninja_list_ticket_forms to find)"),
      tags: z.array(z.string()).optional().describe("Optional tags")
    }).strict().refine(
      (v) => v.organization_id || v.organization_name || v.organization_domain,
      { message: "Provide organization_id, organization_name, or organization_domain." }
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (input) => {
    const ticket = await ninja.createTicket(input);
    return jsonResult({ created: true, ticket });
  }
);

server.registerTool(
  "ninja_update_ticket",
  {
    title: "Update NinjaOne Ticket",
    description: `Update an existing NinjaOne ticket. Can change summary, status, priority, severity, type, or assignee. You can also attach a comment in the same call.

To close a ticket: set status to "RESOLVED" or "CLOSED".
To re-open: set status to "OPEN".
To put on hold waiting for the client: set status to "WAITING".

Only supply the fields you want to change — unset fields are left as-is.`,
    inputSchema: z.object({
      ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID to update"),
      summary: z.string().min(3).max(200).optional().describe("New ticket summary/subject"),
      status: z.enum(["NEW", "OPEN", "WAITING", "PAUSED", "RESOLVED", "CLOSED"]).optional().describe("New ticket status"),
      type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional().describe("New ticket type"),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional().describe("New priority"),
      severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional().describe("New severity"),
      assigned_app_user_id: z.coerce.number().int().positive().optional().describe("User ID to assign the ticket to"),
      comment_body: z.string().min(1).optional().describe("Comment or note to add to the ticket at the same time"),
      comment_public: z.boolean().optional().default(true).describe("Whether the comment is visible to the client (true) or internal only (false)")
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (input) => {
    const ticket = await ninja.updateTicket(input);
    return jsonResult({ updated: true, ticket });
  }
);

server.registerTool(
  "ninja_add_comment",
  {
    title: "Add Comment to NinjaOne Ticket",
    description: `Add a reply or internal note to a NinjaOne ticket.

Set public to true (default) for a client-visible reply.
Set public to false for an internal technician note.`,
    inputSchema: z.object({
      ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID"),
      body: z.string().min(1).describe("Comment text"),
      public: z.boolean().optional().default(true).describe("True = visible to client, false = internal note"),
      time_tracked: z.number().int().min(0).optional().describe("Time spent in seconds (optional, for time tracking)")
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async ({ ticket_id, body, public: isPublic, time_tracked }) => {
    const ticket = await ninja.addComment(ticket_id, {
      body,
      public: isPublic,
      timeTracked: time_tracked
    });
    return jsonResult({ commented: true, ticket });
  }
);

server.registerTool(
  "ninja_get_ticket_log",
  {
    title: "Get NinjaOne Ticket Log",
    description: "Return the full activity and comment log for a NinjaOne ticket. Includes technician notes, status changes, and client replies. Read-only.",
    inputSchema: z.object({
      ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ ticket_id }) => jsonResult(await ninja.listTicketLogEntries(ticket_id))
);

server.registerTool(
  "ninja_list_ticket_attributes",
  {
    title: "List NinjaOne Ticket Attributes",
    description: "Return the available ticket attribute definitions for this NinjaOne tenant (e.g. custom fields, drop-down options). Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => jsonResult(await ninja.listTicketAttributes())
);

server.registerTool(
  "ninja_list_tickets_for_board",
  {
    title: "List Tickets for NinjaOne Board",
    description: "Return tickets currently on a specific NinjaOne board. Use ninja_list_ticket_boards to find board IDs. Read-only.",
    inputSchema: z.object({
      board_id: z.coerce.number().int().positive().describe("NinjaOne board ID (use ninja_list_ticket_boards to find)")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ board_id }) => jsonResult(await ninja.listTicketsForBoard(board_id))
);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  const missing = getMissingVars();
  if (missing.length > 0) {
    res.json({ ok: true, configured: false, missing, service: "ninja-ticket-mcp-server", version: "0.3.0" });
    return;
  }
  res.json({ ok: true, configured: true, service: "ninja-ticket-mcp-server", version: "0.3.0" });
});


// ── MCP OAuth 2.1 (per-user, autoamtic via Claude.ai) ─────────────────────────

app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  res.json(discoveryDoc(config));
});

app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.json(protectedResourceDoc(config));
});

app.post("/oauth/register", requireConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handleRegister(req, res, sessionStore);
  } catch (error) {
    next(error);
  }
});

app.get("/oauth/authorize", requireConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handleAuthorize(req, res, config, sessionStore);
  } catch (error) {
    next(error);
  }
});

app.post("/oauth/token", requireConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handleToken(req, res, sessionStore);
  } catch (error) {
    next(error);
  }
});

// ── Legacy single-user login flow (still supported as a fallback) ─────────────

app.get("/auth/login", requireSharedSecret, requireConfigured, (_req: Request, res: Response) => {
  if (!config.oauthRedirectUri) {
    res.status(500).send("OAuth redirect URI is not configured. Set PUBLIC_BASE_URL or OAUTH_REDIRECT_URI.");
    return;
  }
  const state = stateCache.create();
  res.redirect(buildAuthorizeUrl(config, state));
});

// Single callback for both flows. We try the MCP flow first (state matches a
// pending MCP auth); if not, fall back to the legacy single-user flow.
app.get("/auth/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const handled = await handleNinjaCallbackForMcp(
      req,
      res,
      config,
      sessionStore,
      (token) => ninja.identifyUserFromToken(token)
    );
    if (handled) return;

    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
    if (error) {
      res.status(400).send(`NinjaOne returned an error: ${error} — ${error_description ?? ""}`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }
    if (!stateCache.consume(state)) {
      res.status(400).send("Invalid or expired state parameter. Restart the login flow.");
      return;
    }

    const tokens = await exchangeCodeForTokens(config, code);
    if (!tokens.refresh_token) {
      res.status(500).send("NinjaOne did not return a refresh_token. Ensure the OAuth app has the 'offline_access' scope enabled.");
      return;
    }

    const now = Date.now();
    const expiresInSeconds = tokens.expires_in ?? 3600;
    await tokenStore.save({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      access_token_expires_at: now + expiresInSeconds * 1000,
      scope: tokens.scope,
      obtained_at: now
    });

    res.set("Content-Type", "text/html").send(`<!doctype html>
<html><body style="font-family:system-ui;max-width:540px;margin:4rem auto;padding:1rem;">
  <h2>Connected to NinjaOne</h2>
  <p>The MCP server now has a user-scoped token. You can close this window and retry your action in Claude.</p>
  <p><small>Scope: ${tokens.scope ?? config.oauthScope}</small></p>
</body></html>`);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/status", requireSharedSecret, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const authed = await ninja.hasUserAuth();
    res.json({ authenticated: authed, login_url: loginUrl(config) });
  } catch (error) {
    next(error);
  }
});

app.get("/debug/test-ninja", requireSharedSecret, requireConfigured, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await ninja.testConnection());
  } catch (error) {
    next(error);
  }
});

app.post("/mcp", requireConfigured, async (req: Request, res: Response) => {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const presented = bearer ?? queryToken;

  let session: Session | undefined;
  let isSharedSecret = false;

  if (presented) {
    session = await sessionStore.getSessionByAccessToken(presented);
    if (!session && config.mcpSharedSecret && presented === config.mcpSharedSecret) {
      isSharedSecret = true;
    }
    if (!session && !isSharedSecret) {
      // Treat unknown token as no auth, fall through to 401.
    }
  }

  if (!session && !isSharedSecret) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer realm="MCP", resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`
      )
      .json({ error: "unauthorized", error_description: "Authenticate via OAuth. See WWW-Authenticate header." });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", () => {
    void transport.close();
  });

  await sessionContext.run(session, async () => {
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
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
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Request failed:", error);
  res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
});

app.listen(config.port, () => {
  console.log(`Ninja ticket MCP server v0.3.0 listening on port ${config.port}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireConfigured(_req: Request, res: Response, next: NextFunction): void {
  const missing = getMissingVars();
  if (missing.length > 0) {
    res.status(503).json({ ok: false, error: "Server is not fully configured. Set the following Railway variables and redeploy.", missing });
    return;
  }
  next();
}

function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpSharedSecret) {
    next();
    return;
  }
  const headerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  if (headerToken !== config.mcpSharedSecret && queryToken !== config.mcpSharedSecret) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
