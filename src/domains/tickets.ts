import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerTicketsDomain({ server, ninja }: DomainContext): void {
  // ── Metadata ───────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_list_ticket_forms",
    {
      title: "List Ticket Forms",
      description: "Return NinjaOne ticket forms so you can choose a form ID. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketForms())
  );

  server.registerTool(
    "ninja_list_ticket_boards",
    {
      title: "List Ticket Boards",
      description: "Return NinjaOne ticket boards (saved filter views) so you can choose a board ID. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketBoards())
  );

  server.registerTool(
    "ninja_list_ticket_statuses",
    {
      title: "List Ticket Statuses",
      description: "Return the configured ticket statuses for this NinjaOne tenant. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketStatuses())
  );

  server.registerTool(
    "ninja_list_ticket_attributes",
    {
      title: "List Ticket Attributes",
      description: "Return the available ticket attribute definitions (custom fields, drop-down options). Use these IDs in the `attributes` field on ticket create/update.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketAttributes())
  );

  // ── Reads ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_get_ticket",
    {
      title: "Get Ticket",
      description: "Retrieve a NinjaOne ticket by numeric ID.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.getTicket(ticket_id))
  );

  server.registerTool(
    "ninja_get_ticket_log",
    {
      title: "Get Ticket Log",
      description: "Return the full activity and comment log for a ticket. Includes notes, status changes, and replies.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.listTicketLogEntries(ticket_id))
  );

  server.registerTool(
    "ninja_list_tickets_for_board",
    {
      title: "List Tickets for Board",
      description: "Return tickets currently on a specific board. Use ninja_list_ticket_boards to find board IDs.",
      inputSchema: z.object({
        board_id: z.coerce.number().int().positive().describe("NinjaOne board ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ board_id }) => jsonResult(await ninja.listTicketsForBoard(board_id))
  );

  // ── Writes ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_create_ticket",
    {
      title: "Create Ticket",
      description: `Create a NinjaOne support ticket for a client organization.

Org resolution (provide one):
1. organization_id — exact numeric ID, fastest and most reliable
2. organization_domain — e.g. "acme.com"; matched against contact emails
3. organization_name — fuzzy matched; errors if ambiguous

Optional: pass requester_email and the server looks up the contact UID. Pass attributes (a map of attribute_id → value) to set custom fields.`,
      inputSchema: z.object({
        organization_name: z.string().min(2).optional(),
        organization_id: z.coerce.number().int().positive().optional(),
        organization_domain: z.string().min(3).optional(),
        location_id: z.coerce.number().int().positive().optional(),
        node_id: z.coerce.number().int().positive().optional().describe("Optional device/node ID to associate"),
        summary: z.string().min(3).max(200).describe("Ticket subject"),
        description: z.string().min(3).max(10000).describe("Full ticket details"),
        type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional(),
        priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional(),
        severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional(),
        status: z.string().optional().describe("Status name (NEW, OPEN, WAITING, PAUSED, RESOLVED, CLOSED) or numeric statusId. Defaults to NEW."),
        requester_email: z.string().email().optional(),
        requester_uid: z.string().optional().describe("Contact UID (skip the email lookup if you already have it)"),
        assigned_app_user_id: z.coerce.number().int().positive().optional(),
        form_id: z.coerce.number().int().positive().optional(),
        tags: z.array(z.string()).optional(),
        attributes: z.record(z.unknown()).optional().describe("Custom field values keyed by attribute ID"),
        cc_emails: z.array(z.string().email()).optional()
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
      title: "Update Ticket",
      description: `Update an existing ticket. Only supply fields you want to change.

To close a ticket: set status to "RESOLVED" or "CLOSED".
To re-open: set status to "OPEN".
To pause pending client reply: set status to "WAITING".

A comment can be attached in the same call via comment_body.`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        summary: z.string().min(3).max(200).optional(),
        status: z.string().optional().describe("Status name (NEW, OPEN, WAITING, PAUSED, RESOLVED, CLOSED) or numeric statusId"),
        type: z.enum(["PROBLEM", "QUESTION", "INCIDENT", "TASK"]).optional(),
        priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional(),
        severity: z.enum(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).optional(),
        assigned_app_user_id: z.coerce.number().int().positive().optional(),
        tags: z.array(z.string()).optional(),
        attributes: z.record(z.unknown()).optional(),
        comment_body: z.string().min(1).optional(),
        comment_public: z.boolean().optional().default(true)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      const ticket = await ninja.updateTicket(input);
      return jsonResult({ updated: true, ticket });
    }
  );

  server.registerTool(
    "ninja_close_ticket",
    {
      title: "Close Ticket",
      description: "Convenience: set a ticket's status to CLOSED. Optionally include a final comment.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        comment_body: z.string().min(1).optional(),
        comment_public: z.boolean().optional().default(true)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id, comment_body, comment_public }) => {
      const ticket = await ninja.updateTicket({
        ticket_id,
        status: "CLOSED",
        comment_body,
        comment_public
      });
      return jsonResult({ closed: true, ticket });
    }
  );

  server.registerTool(
    "ninja_add_comment",
    {
      title: "Add Ticket Comment",
      description: `Add a public reply (client-visible) or internal note to a ticket.

time_tracked is in seconds and is optional.`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        body: z.string().min(1),
        public: z.boolean().optional().default(true),
        time_tracked: z.number().int().min(0).optional().describe("Time spent in seconds")
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
}
