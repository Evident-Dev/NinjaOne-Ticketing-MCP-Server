// Customers domain — organizations + contacts. Useful for ticket workflows
// (org lookup before create) and account-management tasks.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerCustomersDomain({ server, ninja }: DomainContext): void {
  // ── Organizations ──────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_find_organizations",
    {
      title: "Find Organizations",
      description: "Search organizations by name (fuzzy). Returns matching org IDs and names. Read-only.",
      inputSchema: z.object({
        query: z.string().min(2),
        limit: z.number().int().min(1).max(50).default(10)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query, limit }) => {
      const matches = await ninja.findOrganizations(query, limit);
      return jsonResult({
        count: matches.length,
        organizations: matches.map((org) => ({ id: org.id, name: org.name }))
      });
    }
  );

  server.registerTool(
    "ninja_find_org_by_domain",
    {
      title: "Find Organization by Email Domain",
      description: `Find an organization by email domain (e.g. "acme.com"). Matched against contact emails registered in NinjaOne. Pass either the bare domain or a full email; everything before @ is stripped.`,
      inputSchema: z.object({
        domain: z.string().min(3)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ domain }) => {
      const bare = domain.includes("@") ? domain.split("@")[1] : domain;
      const orgs = await ninja.findOrgsByDomain(bare);
      if (orgs.length === 0) return jsonResult({ found: false, domain: bare, organizations: [] });
      return jsonResult({
        found: true,
        domain: bare,
        organizations: orgs.map((o) => ({ id: o.id, name: o.name }))
      });
    }
  );

  server.registerTool(
    "ninja_get_organization",
    {
      title: "Get Organization",
      description: "Retrieve a single organization by ID.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id }) => jsonResult(await ninja.getOrganization(organization_id))
  );

  server.registerTool(
    "ninja_list_organization_locations",
    {
      title: "List Organization Locations",
      description: "List the locations (sites) belonging to an organization.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id }) => jsonResult(await ninja.getOrganizationLocations(organization_id))
  );

  server.registerTool(
    "ninja_create_organization",
    {
      title: "Create Organization",
      description: "Create a new customer organization in NinjaOne.",
      inputSchema: z.object({
        name: z.string().min(2).max(100),
        description: z.string().max(1000).optional(),
        node_approval_mode: z.enum(["AUTOMATIC", "MANUAL", "REJECT"]).optional()
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ name, description, node_approval_mode }) => {
      const org = await ninja.createOrganization({
        name,
        description,
        nodeApprovalMode: node_approval_mode
      });
      return jsonResult({ created: true, organization: org });
    }
  );

  // ── Contacts ───────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_find_contact",
    {
      title: "Find Contact",
      description: "Search contacts by name or email. Returns each contact's UID (needed as requester on a ticket) and their organization_id.",
      inputSchema: z.object({
        query: z.string().min(2)
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
}
