// Status/identity tools — registered on every MCP endpoint so you can always
// check who you are and whether the connection is healthy.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerStatusDomain({ server, ninja, config }: DomainContext): void {
  server.registerTool(
    "ninja_status",
    {
      title: "NinjaOne Connection Status",
      description: "Confirm the MCP server can reach NinjaOne and report region, scopes, and a small organization sample. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => {
      const result = await ninja.testConnection();
      return jsonResult({
        ok: result.ok,
        region: config.ninjaRegion,
        api_base_url: config.ninjaApiBaseUrl,
        scopes: config.oauthScope,
        org_count: result.orgCount,
        sample_orgs: result.sample
      });
    }
  );

  server.registerTool(
    "ninja_auth_status",
    {
      title: "NinjaOne User-Context Auth Status",
      description:
        "Check whether a user-context refresh token is on file (required for ticket writes, comments, and updates). Always returns the login_url. " +
        "If `authenticated` is false, instruct the user to open `login_url` in a browser and sign in to NinjaOne, then retry their request.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const status = await ninja.userOAuth.getStatus();
      return jsonResult({
        ...status,
        login_url: ninja.userOAuth.loginUrl(),
        message: status.authenticated
          ? "User-context token is active. Ticket writes should work."
          : "No user-context token on file. Ticket writes will fail. ASK THE USER to visit login_url in a browser to sign in once."
      });
    }
  );

  server.registerTool(
    "ninja_whoami",
    {
      title: "NinjaOne Technician Identity",
      description: "Return the technician profile this server is configured to act as (set via TECHNICIAN_EMAIL). This is whose name will appear on ticket comments.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const profile = await ninja.getTechnicianProfile();
      if (!profile) {
        return jsonResult({
          configured: false,
          message: "TECHNICIAN_EMAIL is not set. Tickets will not be auto-assigned and comments will not be signed."
        });
      }
      return jsonResult({
        configured: true,
        display_name: profile.displayName,
        email: profile.email,
        ninja_user_id: profile.appUserId
      });
    }
  );
}
