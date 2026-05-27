// Users domain — read-only technician/end-user listing.
// Supports assignee autocomplete for tickets and "who are my techs" queries.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerUsersDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_user_list",
    {
      title: "User: List",
      description:
        "List NinjaOne users. By default returns technicians only — pass include_end_users to also include contact end-users. Use to find appUserIds for ticket assignment.",
      inputSchema: z.object({
        include_end_users: z.boolean().optional().default(false)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ include_end_users }) => {
      const users = include_end_users
        ? await ninja.listAllUsers()
        : await ninja.listAllUsers({ userType: "TECHNICIAN" });
      return jsonResult({
        count: users.length,
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
          user_type: u.userType,
          enabled: u.enabled !== false
        }))
      });
    }
  );

  server.registerTool(
    "ninja_user_find",
    {
      title: "User: Find by Name or Email",
      description:
        "Search NinjaOne users by name or email substring. Useful for resolving 'assign to <person>' requests — returns the appUserId you'd pass as assigned_app_user_id on a ticket.",
      inputSchema: z.object({
        query: z.string().min(2)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query }) => {
      const lower = query.trim().toLowerCase();
      const users = await ninja.listAllUsers();
      const matches = users.filter(
        (u) =>
          u.email?.toLowerCase().includes(lower) ||
          u.firstName?.toLowerCase().includes(lower) ||
          u.lastName?.toLowerCase().includes(lower) ||
          `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(lower)
      );
      return jsonResult({
        count: matches.length,
        users: matches.map((u) => ({
          id: u.id,
          email: u.email,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
          user_type: u.userType,
          enabled: u.enabled !== false
        }))
      });
    }
  );
}
