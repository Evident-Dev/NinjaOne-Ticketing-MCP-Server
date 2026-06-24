// Vulnerability management — scan groups. NinjaOne's public API exposes
// vulnerability data as scan groups: batches of third-party scanner results
// uploaded as CSV. There is no per-CVE or per-device vulnerability read, so
// these tools manage the scan groups themselves.

import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerVulnerabilitiesDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_scangroup_list",
    {
      title: "Vulnerability: List Scan Groups",
      description:
        "List vulnerability scan groups — uploaded batches of third-party scanner results. Shows each group's name, vendor, status, and records processed. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => jsonResult(await ninja.listScanGroups())
  );

  server.registerTool(
    "ninja_scangroup_get",
    {
      title: "Vulnerability: Get Scan Group",
      description: "Retrieve a single vulnerability scan group by ID, including its status and CSV-mapping configuration.",
      inputSchema: z.object({
        scan_group_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ scan_group_id }) => jsonResult(await ninja.getScanGroup(scan_group_id))
  );

  server.registerTool(
    "ninja_scangroup_upload_csv",
    {
      title: "Vulnerability: Upload Scan CSV",
      description:
        "Upload a CSV of third-party scanner results to a scan group. The CSV columns must match the group's configured device and CVE header mapping (see ninja_scangroup_get).",
      inputSchema: z.object({
        scan_group_id: z.coerce.number().int().positive(),
        csv: z.string().min(1).describe("Raw CSV content of the scan results")
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ scan_group_id, csv }) => {
      await ninja.uploadScanGroupCsv(scan_group_id, csv);
      return jsonResult({ uploaded: true, scan_group: await ninja.getScanGroup(scan_group_id) });
    }
  );
}
