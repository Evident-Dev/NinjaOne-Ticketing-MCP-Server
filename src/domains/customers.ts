// Customer-management WRITES. Read-only org + contact lookups live in
// ./lookup.ts and are attached to every slice. This file is just the
// org-create tool — anything that mutates customer records.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerCustomersDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_create_organization",
    {
      title: "Create Organization",
      description: "Create a new customer organization in NinjaOne. Destructive — confirm with the user before calling.",
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
}
