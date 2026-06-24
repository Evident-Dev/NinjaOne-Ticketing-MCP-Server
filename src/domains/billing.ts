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
    "ninja_billing_list_customer_accounts",
    {
      title: "Billing: List Customer Accounts",
      description: "List customer billing accounts (the receivables side of an organization).",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listCustomerAccounts())
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
}
