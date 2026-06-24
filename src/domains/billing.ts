// Billing domain — contracts (agreements), invoices, products, customer
// accounts, and ticket time entries. Read-only; billable time is logged via
// ninja_ticket_add_billable_time (a time entry on a ticket comment), which is
// the only write path NinjaOne's public API exposes for ticket billing.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerBillingDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_billing_list_agreements",
    {
      title: "Billing: List Agreements (Contracts)",
      description:
        "List billing agreements (contracts). Optionally scope to a single organization. Use ninja_org_find first if you only have the client's name. Read-only.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive().optional()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id }) => jsonResult(await ninja.listAgreements(organization_id))
  );

  server.registerTool(
    "ninja_billing_get_agreement",
    {
      title: "Billing: Get Agreement",
      description: "Retrieve a single billing agreement (contract) by ID, including its line items.",
      inputSchema: z.object({
        agreement_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ agreement_id }) => jsonResult(await ninja.getAgreement(agreement_id))
  );

  server.registerTool(
    "ninja_billing_list_invoices",
    {
      title: "Billing: List Invoices",
      description: "List invoices. Optionally filter by organization or status.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive().optional(),
        status: z.string().optional().describe("Optional status filter (e.g. DRAFT, SENT, PAID)")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id, status }) =>
      jsonResult(await ninja.listInvoices({ organizationId: organization_id, status }))
  );

  server.registerTool(
    "ninja_billing_get_invoice",
    {
      title: "Billing: Get Invoice",
      description: "Retrieve a single invoice by ID, including line items.",
      inputSchema: z.object({
        invoice_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ invoice_id }) => jsonResult(await ninja.getInvoice(invoice_id))
  );

  server.registerTool(
    "ninja_billing_list_products",
    {
      title: "Billing: List Products",
      description: "List billable products defined in NinjaOne. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listBillingProducts())
  );

  server.registerTool(
    "ninja_billing_list_accounts",
    {
      title: "Billing: List Accounts",
      description: "List billing accounts (e.g. Ticket Time Entry, Managed Services) used to categorize charges. The account id is required when adding a ticket product. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listBillingAccounts())
  );

  server.registerTool(
    "ninja_billing_list_ticket_time",
    {
      title: "Billing: List Ticket Time Entries",
      description:
        "List billable time entries logged on a ticket (the time tracked by ninja_ticket_add_billable_time). Shows seconds tracked, billing status, and the agreement each entry bills against. Read-only.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => {
      const log = await ninja.listTicketLogEntries(ticket_id);
      const entries = Array.isArray(log) ? log : [];
      const timeEntries = entries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>).ticketTimeEntry != null)
        .map((e) => ({
          log_entry_id: e.id,
          create_time: e.createTime,
          body: e.body,
          time_tracked_seconds: e.timeTracked,
          time_entry: e.ticketTimeEntry
        }));
      return jsonResult({ ticket_id, count: timeEntries.length, time_entries: timeEntries });
    }
  );

  server.registerTool(
    "ninja_billing_list_ticket_products",
    {
      title: "Billing: List Ticket Products",
      description:
        "List billable product line items attached to a ticket (parts, fixed charges, etc.). Distinct from time entries — use ninja_billing_list_ticket_time for logged labor. Read-only.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.listTicketProducts(ticket_id))
  );

  server.registerTool(
    "ninja_billing_add_ticket_product",
    {
      title: "Billing: Add Ticket Product (line item)",
      description: `Add a free-form billable line item (a part, fixed charge, etc.) to a ticket — NOT for logging labor time (use ninja_ticket_add_billable_time for that).

Requires account_id from ninja_billing_list_accounts (e.g. Hardware, Software). Billing defaults to BILLABLE. The ticket's client must have a billing agreement, or NinjaOne rejects it with "agreement_is_required".

Example: { ticket_id: 1010, account_id: 2, name: "Replacement SSD", quantity: 1, price: 120 }`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        account_id: z.coerce.number().int().positive().describe("Billing account id from ninja_billing_list_accounts"),
        name: z.string().min(1).max(200),
        description: z.string().max(500).optional(),
        quantity: z.coerce.number().positive(),
        price: z.coerce.number().nonnegative().describe("Unit price charged to the client"),
        cost: z.coerce.number().nonnegative().optional().describe("Your unit cost, for margin reporting"),
        billable: z.boolean().optional().default(true),
        taxable: z.boolean().optional().default(false)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) =>
      jsonResult({
        added: true,
        ticket_product: await ninja.createAdhocTicketProduct({
          ticketId: input.ticket_id,
          accountId: input.account_id,
          name: input.name,
          description: input.description,
          quantity: input.quantity,
          price: input.price,
          cost: input.cost,
          billable: input.billable,
          taxable: input.taxable
        })
      })
  );
}
