import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { NinjaClient } from "./ninja.js";

const config = loadConfig();
const ninja = new NinjaClient(config);

const server = new McpServer({
  name: "ninja-ticket-mcp-server",
  version: "0.1.0"
});

server.registerTool(
  "ninja_find_organizations",
  {
    title: "Find NinjaOne Organizations",
    description: "Search NinjaOne organizations by name and return matching organization IDs. Read-only.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Client or organization name to search for"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max orgs to return")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ query, limit }) => {
    const matches = await ninja.findOrganizations(query, limit);
    return jsonResult({ count: matches.length, organizations: matches.map((org) => ({ id: org.id, name: org.name })) });
  }
);

server.registerTool(
  "ninja_list_ticket_forms",
  {
    title: "List NinjaOne Ticket Forms",
    description: "Return NinjaOne ticket forms so you can choose a default form ID. Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async () => jsonResult(await ninja.listTicketForms())
);

server.registerTool(
  "ninja_list_ticket_boards",
  {
    title: "List NinjaOne Ticket Boards",
    description: "Return NinjaOne ticket boards so you can choose a default board ID. Read-only.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async () => jsonResult(await ninja.listTicketBoards())
);

server.registerTool(
  "ninja_create_ticket",
  {
    title: "Create NinjaOne Ticket",
    description: `Create a NinjaOne ticket attached to an organization.

Use organization_id when known. Otherwise use organization_name and the server will resolve it first.
If more than one organization matches, the tool refuses to create the ticket and returns the matching org IDs.
This tool only creates a ticket. It does not run scripts, remote control devices, or modify endpoints.`,
    inputSchema: z.object({
      organization_name: z.string().min(2).optional().describe("NinjaOne organization/client name"),
      organization_id: z.number().int().positive().optional().describe("Exact NinjaOne organization ID"),
      subject: z.string().min(3).max(250).describe("Ticket subject"),
      description: z.string().min(3).max(10000).describe("Ticket details"),
      priority: z.string().max(50).optional().describe("Optional priority value expected by your NinjaOne form"),
      requester_email: z.string().email().optional().describe("Optional requester email"),
      form_id: z.number().int().positive().optional().describe("Optional ticket form ID"),
      board_id: z.number().int().positive().optional().describe("Optional board ID")
    }).strict().refine((value) => value.organization_id || value.organization_name, {
      message: "Provide organization_id or organization_name."
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (input) => {
    const ticket = await ninja.createTicket(input);
    return jsonResult({ created: true, ticket });
  }
);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "ninja-ticket-mcp-server" });
});

// Tiny helper endpoint for sanity checks outside MCP. Protected by the same shared secret.
app.get("/debug/test-ninja", requireSharedSecret, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await ninja.testConnection());
  } catch (error) {
    next(error);
  }
});

app.post("/mcp", requireSharedSecret, async (req: Request, res: Response) => {
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
  res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : "Unknown error"
  });
});

app.listen(config.port, () => {
  console.log(`Ninja ticket MCP server listening on port ${config.port}`);
});

function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpSharedSecret) {
    // Handy for local tinkering, but set MCP_SHARED_SECRET in Railway.
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
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}
