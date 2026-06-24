import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";
import { confirmField, dryRunField, dryRunPreview, isCapabilityAllowed } from "../guardrails.js";

export function registerTicketsDomain({ server, ninja, config }: DomainContext): void {
  // ── Ticketing metadata ─────────────────────────────────────────────────────

  server.registerTool(
    "ninja_ticket_list_forms",
    {
      title: "Ticket: List Forms",
      description: "Return NinjaOne ticket forms so you can choose a form_id when creating a ticket. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketForms())
  );

  server.registerTool(
    "ninja_ticket_list_boards",
    {
      title: "Ticket: List Boards",
      description: "Return NinjaOne ticket boards (saved filter views). Pass board IDs to ninja_ticket_list_for_board. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketBoards())
  );

  server.registerTool(
    "ninja_ticket_list_statuses",
    {
      title: "Ticket: List Statuses",
      description: "Return the configured ticket statuses for this NinjaOne tenant. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketStatuses())
  );

  server.registerTool(
    "ninja_ticket_list_attributes",
    {
      title: "Ticket: List Attributes",
      description: "Return the available ticket attribute definitions (custom fields, drop-down options). Use these IDs in the `attributes` field on ninja_ticket_create / ninja_ticket_update.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listTicketAttributes())
  );

  // ── Ticket reads ───────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_ticket_get",
    {
      title: "Ticket: Get",
      description: "Retrieve a NinjaOne ticket by numeric ID.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.getTicket(ticket_id))
  );

  server.registerTool(
    "ninja_ticket_get_log",
    {
      title: "Ticket: Get Activity Log",
      description: "Return the full activity and comment log for a ticket. Includes notes, status changes, and replies.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive().describe("NinjaOne ticket ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.listTicketLogEntries(ticket_id))
  );

  server.registerTool(
    "ninja_ticket_list_for_board",
    {
      title: "Ticket: List for Board",
      description: "Return tickets currently on a specific board. Use ninja_ticket_list_boards to find board IDs.",
      inputSchema: z.object({
        board_id: z.coerce.number().int().positive().describe("NinjaOne board ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ board_id }) => jsonResult(await ninja.listTicketsForBoard(board_id))
  );

  // ── Ticket writes ──────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_ticket_create",
    {
      title: "Ticket: Create",
      description: `Create a NinjaOne support ticket for a client organization.

Org resolution (provide one):
1. organization_id — exact numeric ID, fastest and most reliable
2. organization_domain — e.g. "acme.com"; matched against contact emails
3. organization_name — fuzzy matched; errors if ambiguous

Optional: pass requester_email and the server looks up the contact UID. Pass attributes (a map of attribute_id → value) to set custom fields.

If you don't know the org_id, call ninja_org_find or ninja_org_find_by_domain first.`,
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
    "ninja_ticket_update",
    {
      title: "Ticket: Update",
      description: `Update an existing ticket. Only supply fields you want to change.

To put on hold pending client reply: set status to "WAITING".
To re-open after resolving: set status to "OPEN".
To resolve / mark done: use ninja_ticket_resolve instead (cleaner UX).

A comment can be attached in the same call via comment_body.`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        summary: z.string().min(3).max(200).optional(),
        status: z.string().optional().describe("Status name (NEW, OPEN, WAITING, PAUSED, RESOLVED) or numeric statusId. NinjaOne does not allow direct transition to CLOSED."),
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
    "ninja_ticket_resolve",
    {
      title: "Ticket: Resolve",
      description:
        "Convenience: set a ticket's status to RESOLVED (the standard 'done' state). NinjaOne treats CLOSED as a terminal archive state reached automatically from RESOLVED — direct close is rejected. Optionally include a final comment.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        comment_body: z.string().min(1).optional(),
        comment_public: z.boolean().optional().default(true),
        status: z
          .enum(["RESOLVED", "CLOSED"])
          .optional()
          .default("RESOLVED")
          .describe("Target status. Defaults to RESOLVED — only override if your tenant allows direct CLOSED transitions.")
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id, comment_body, comment_public, status }) => {
      const ticket = await ninja.updateTicket({
        ticket_id,
        status,
        comment_body,
        comment_public
      });
      return jsonResult({ resolved: true, status, ticket });
    }
  );

  server.registerTool(
    "ninja_ticket_add_comment",
    {
      title: "Ticket: Add Comment",
      description: `Add a public reply (client-visible) or internal note to a ticket.

time_tracked is in seconds and is optional.`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        body: z.string().min(1),
        public: z.boolean().optional().default(true),
        time_tracked: z.coerce.number().int().min(0).optional().describe("Time spent in seconds")
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

  // Convenience: add a billable line item (time or product) to a ticket.
  // Mirrors ninja_billing_add_ticket_product — shipped here so help-desk techs
  // working from /mcp/tickets don't need to swap endpoints.
  server.registerTool(
    "ninja_ticket_add_billable_time",
    {
      title: "Ticket: Add Billable Time",
      description: `Log billable time on a ticket as a billing line item. Accepts hours (decimal) or minutes.

Either pass product_id (the configured "Labor" or "Service" product) to use that product's rate, OR pass description + unit_price for a free-form charge.

Examples:
- 1.5h at the default labor rate: { ticket_id, product_id: 42, hours: 1.5 }
- 45 minutes at $125/hr: { ticket_id, description: "Onsite triage", minutes: 45, unit_price: 125 }`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        product_id: z.coerce.number().int().positive().optional(),
        description: z.string().min(1).max(500).optional(),
        hours: z.coerce.number().positive().optional(),
        minutes: z.coerce.number().positive().optional(),
        unit_price: z.coerce.number().nonnegative().optional(),
        notes: z.string().max(2000).optional()
      }).strict().refine(
        (v) => v.hours !== undefined || v.minutes !== undefined,
        { message: "Provide either hours or minutes." }
      ).refine(
        (v) => v.product_id || (v.description && v.unit_price !== undefined),
        { message: "Provide product_id, or description + unit_price." }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      const quantity = input.hours ?? (input.minutes ? input.minutes / 60 : 0);
      const result = await ninja.createTicketProduct({
        ticketId: input.ticket_id,
        productId: input.product_id,
        description: input.description,
        quantity,
        unitPrice: input.unit_price,
        notes: input.notes
      });
      return jsonResult({ added: true, quantity_hours: quantity, ticket_product: result });
    }
  );

  // ── Destructive: gated by NINJA_ALLOW_DESTRUCTIVE=ticket_delete ──────────
  if (isCapabilityAllowed(config, "ticket_delete")) {
    server.registerTool(
      "ninja_ticket_delete",
      {
        title: "Ticket: DELETE (permanent)",
        description:
          "Permanently delete a ticket. IRREVERSIBLE — for normal workflow use ninja_ticket_resolve instead. Requires confirm=\"DELETE\". Recommend dry_run=true first.",
        inputSchema: z.object({
          ticket_id: z.coerce.number().int().positive(),
          confirm: confirmField("DELETE", "permanent ticket removal"),
          dry_run: dryRunField
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ ticket_id, dry_run }) => {
        const target = await ninja.getTicket(ticket_id);
        if (dry_run) {
          return jsonResult(
            dryRunPreview(`DELETE /ticketing/ticket/${ticket_id}`, { ticket_id }, {
              ticket_id,
              subject: target.subject,
              client_id: target.clientId
            })
          );
        }
        await ninja.deleteTicket(ticket_id);
        return jsonResult({ deleted: true, ticket_id, deleted_ticket: target });
      }
    );
  }
}
