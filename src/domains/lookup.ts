// Read-only org + contact lookups. Attached to every domain slice (tickets,
// devices, alerts, customers) so any workflow that needs to resolve a customer
// by name, email-domain, or contact has these tools available without forcing
// the user to add a second MCP endpoint.
//
// Cheap by design: every tool here is a read-only API call against cached
// data. Adding them to all slices doesn't meaningfully bloat tool-schema
// tokens — five small lookup tools.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerLookupDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_find_organizations",
    {
      title: "Find Organizations",
      description:
        "Search organizations by name (fuzzy match). Returns matching org IDs and names. Use this FIRST when a user mentions a customer/client by name and you need the numeric organization_id (e.g. before creating a ticket). Read-only.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Org/client name to search for"),
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
      description:
        "Look up an organization by an email domain (e.g. \"acme.com\"). Matched against contact emails registered in NinjaOne. Use this when you have a customer's email and need to identify which org they belong to. Accepts either a bare domain or a full email address — everything before @ is stripped.",
      inputSchema: z.object({
        domain: z.string().min(3).describe("Domain like \"acme.com\" or a full email like \"jane@acme.com\"")
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
      description: "Retrieve full details for a single organization by ID — including locations and policies.",
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
      description: "List the locations (sites) belonging to an organization. Useful when a ticket needs a specific location_id.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id }) => jsonResult(await ninja.getOrganizationLocations(organization_id))
  );

  server.registerTool(
    "ninja_find_contact",
    {
      title: "Find Contact",
      description:
        "Search NinjaOne contacts by name or email. Returns each contact's UID (which can be passed as requester_uid on a ticket to skip the email lookup) and their organization_id. Use this when you know the requester's name/email and want to attach them to a ticket properly.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Name, email, or partial of either")
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
