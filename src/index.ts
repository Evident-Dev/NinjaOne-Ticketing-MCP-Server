import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getMissingVars, loadConfig } from "./config.js";
import { NinjaClient } from "./ninja.js";

const config = loadConfig();
const ninja = new NinjaClient(config);

const server = new McpServer({
  name: "ninja-ticket-mcp-server",
  version: "0.2.0"
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
      ticket_id: z.number().int().positive().describe("NinjaOne ticket ID")
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
      organization_id: z.number().int().positive().optional().describe("Exact NinjaOne organization ID"),
      organization_domain: z.string().min(3).optional().describe("Email domain of the client, e.g. acme.com"),
      summary: z.string().min(3).max(200).describe("Ticket subject / one-line summary"),
      description: z.string().min(3).max(10000).describe("Full ticket details"),
      type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional().describe("Ticket type: PROBLEM (something is broken), QUESTION (information needed), INCIDENT (ongoing outage/impact), TASK (planned work)"),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional().describe("Ticket priority"),
      severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional().describe("Impact severity"),
      status: z.enum(["NEW", "OPEN", "WAITING", "PAUSED", "RESOLVED", "CLOSED"]).optional().describe("Initial status (defaults to NEW)"),
      requester_email: z.string().email().optional().describe("Email of the person requesting support — looked up in NinjaOne contacts to set requester"),
      form_id: z.number().int().positive().optional().describe("Ticket form ID (use ninja_list_ticket_forms to find)"),
      board_id: z.number().int().positive().optional().describe("Board ID (use ninja_list_ticket_boards to find)"),
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
      ticket_id: z.number().int().positive().describe("NinjaOne ticket ID to update"),
      summary: z.string().min(3).max(200).optional().describe("New ticket summary/subject"),
      status: z.enum(["NEW", "OPEN", "WAITING", "PAUSED", "RESOLVED", "CLOSED"]).optional().describe("New ticket status"),
      type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional().describe("New ticket type"),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional().describe("New priority"),
      severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional().describe("New severity"),
      assigned_app_user_id: z.number().int().positive().optional().describe("User ID to assign the ticket to"),
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
      ticket_id: z.number().int().positive().describe("NinjaOne ticket ID"),
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

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  const missing = getMissingVars();
  if (missing.length > 0) {
    res.json({ ok: true, configured: false, missing, service: "ninja-ticket-mcp-server", version: "0.2.0" });
    return;
  }
  res.json({ ok: true, configured: true, service: "ninja-ticket-mcp-server", version: "0.2.0" });
});


app.get("/debug/test-ninja", requireSharedSecret, requireConfigured, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await ninja.testConnection());
  } catch (error) {
    next(error);
  }
});

app.post("/mcp", requireSharedSecret, requireConfigured, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", () => {
    void transport.close();
  });

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

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Request failed:", error);
  res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
});

app.listen(config.port, () => {
  console.log(`Ninja ticket MCP server v0.2.0 listening on port ${config.port}`);
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
  const expected = `Bearer ${config.mcpSharedSecret}`;
  const actual = req.header("authorization") || "";
  if (actual !== expected) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
