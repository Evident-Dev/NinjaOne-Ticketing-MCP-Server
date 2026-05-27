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
      description:
        "Return the technician whose name will appear on tickets and comments for the CURRENT connection. " +
        "Priority: explicit tool argument > per-tech URL token (NINJA_TECHNICIANS) > TECHNICIAN_EMAIL config. " +
        "Reports which source resolved the identity so multi-tech deployments can debug who they are.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const resolved = ninja.resolveTechnicianEmail();
      const profile = await ninja.getTechnicianProfile();
      if (!profile) {
        return jsonResult({
          configured: false,
          source: resolved.source,
          requested_email: resolved.email ?? null,
          message:
            resolved.source === "none"
              ? "No technician identity configured. Either connect via a personal URL token (NINJA_TECHNICIANS) or set TECHNICIAN_EMAIL on the server."
              : `Email "${resolved.email}" was provided (source: ${resolved.source}) but no matching NinjaOne user was found. Tickets won't be auto-assigned and comments won't be signed.`
        });
      }
      return jsonResult({
        configured: true,
        source: resolved.source,
        display_name: profile.displayName,
        email: profile.email,
        ninja_user_id: profile.appUserId
      });
    }
  );
}
