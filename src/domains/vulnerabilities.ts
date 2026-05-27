// Vulnerability management — read-only security-triage tools.
// Powers prompts like "show me critical vulns across all customers" or
// "what CVEs is this server exposed to."

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerVulnerabilitiesDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_vuln_list",
    {
      title: "Vulnerability: List",
      description:
        "List vulnerabilities currently detected in the environment. Optionally scope to a single organization and/or severity. Use ninja_org_find first if you only have the customer's name.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive().optional(),
        severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
        page_size: z.number().int().min(1).max(500).default(100)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id, severity, page_size }) =>
      jsonResult(
        await ninja.listVulnerabilities({
          organizationId: organization_id,
          severity,
          pageSize: page_size
        })
      )
  );

  server.registerTool(
    "ninja_vuln_get",
    {
      title: "Vulnerability: Get by CVE",
      description: "Look up a specific vulnerability by CVE identifier (e.g. CVE-2024-12345).",
      inputSchema: z.object({
        cve: z.string().min(4).describe("CVE identifier, e.g. CVE-2024-12345")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ cve }) => jsonResult(await ninja.getVulnerability(cve))
  );

  server.registerTool(
    "ninja_vuln_list_for_device",
    {
      title: "Vulnerability: List for Device",
      description: "List vulnerabilities detected on a specific device.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.listDeviceVulnerabilities(device_id))
  );
}
