// Billing domain — contracts (agreements), invoices, products, customer
// accounts, and ticket-products (billable time on a ticket). Read-only for
// 0.9.0 except for add_ticket_product, which is the workflow win that closes
// the time-tracking → invoice loop.

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
      description: "List billable products defined in NinjaOne. Use the returned product IDs with ninja_billing_add_ticket_product.",
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
    "ninja_billing_list_ticket_products",
    {
      title: "Billing: List Ticket Products",
      description:
        "List billable line items attached to tickets. Pass ticket_id to filter to one ticket. Use to see what's already been billed before adding more.",
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive().optional()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ticket_id }) => jsonResult(await ninja.listTicketProducts(ticket_id))
  );

  server.registerTool(
    "ninja_billing_add_ticket_product",
    {
      title: "Billing: Add Billable Product/Time to Ticket",
      description: `Attach a billable line item to a ticket — used to log billable hours or charge for a product.

Provide either:
- product_id (with optional quantity/unit_price override), OR
- description + quantity + unit_price (free-form line item)

Returns the created ticket-product record.`,
      inputSchema: z.object({
        ticket_id: z.coerce.number().int().positive(),
        product_id: z.coerce.number().int().positive().optional(),
        description: z.string().min(1).max(500).optional(),
        quantity: z.number().positive().optional(),
        unit_price: z.number().nonnegative().optional(),
        discount_amount: z.number().nonnegative().optional(),
        discount_percent: z.number().min(0).max(100).optional(),
        notes: z.string().max(2000).optional()
      }).strict().refine(
        (v) => v.product_id || (v.description && v.quantity !== undefined && v.unit_price !== undefined),
        { message: "Provide product_id, or all of description + quantity + unit_price." }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) =>
      jsonResult({
        added: true,
        ticket_product: await ninja.createTicketProduct({
          ticketId: input.ticket_id,
          productId: input.product_id,
          description: input.description,
          quantity: input.quantity,
          unitPrice: input.unit_price,
          discountAmount: input.discount_amount,
          discountPercent: input.discount_percent,
          notes: input.notes
        })
      })
  );
}
