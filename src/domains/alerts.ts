import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";
import { confirmField, dryRunField, dryRunPreview, isCapabilityAllowed } from "../guardrails.js";

export function registerAlertsDomain({ server, ninja, config }: DomainContext): void {
  server.registerTool(
    "ninja_alert_list",
    {
      title: "Alert: List",
      description: "List active alerts. Optionally scope to a device or alert source type. Read-only.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive().optional(),
        source_type: z.string().optional().describe("Filter by alert source type (e.g. CONDITION, PATCH, AV)")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id, source_type }) => {
      const alerts = await ninja.listAlerts({ deviceId: device_id, sourceType: source_type });
      return jsonResult({ count: alerts.length, alerts });
    }
  );

  server.registerTool(
    "ninja_alert_summary",
    {
      title: "Alert: Summary by Severity",
      description: "Count current alerts grouped by severity. Useful for at-a-glance NOC reporting.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive().optional()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => {
      const alerts = await ninja.listAlerts({ deviceId: device_id });
      const summary: Record<string, number> = {};
      for (const alert of alerts) {
        const sev = alert.severity ?? "UNKNOWN";
        summary[sev] = (summary[sev] ?? 0) + 1;
      }
      return jsonResult({ total: alerts.length, by_severity: summary });
    }
  );

  server.registerTool(
    "ninja_alert_reset",
    {
      title: "Alert: Reset",
      description: "Acknowledge / dismiss a single alert by its UID.",
      inputSchema: z.object({
        alert_uid: z.string().min(1)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ alert_uid }) => {
      await ninja.resetAlert(alert_uid);
      return jsonResult({ reset: true, alert_uid });
    }
  );

  // ── Destructive: gated by NINJA_ALLOW_DESTRUCTIVE=alert_reset_all ────────
  if (isCapabilityAllowed(config, "alert_reset_all")) {
    server.registerTool(
      "ninja_alert_reset_all",
      {
        title: "Alert: RESET ALL by Source (bulk)",
        description:
          "Bulk-acknowledge every active alert of a given source type. POTENTIALLY DISRUPTIVE — alerts that were valid will reappear on next condition check, but staff lose the active-alert signal in between. Requires confirm=\"RESET\". Recommend dry_run=true first.",
        inputSchema: z.object({
          source_type: z.string().min(2).describe("Alert source type, e.g. CONDITION, PATCH, AV"),
          confirm: confirmField("RESET", "bulk alert reset"),
          dry_run: dryRunField
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ source_type, dry_run }) => {
        const matching = await ninja.listAlerts({ sourceType: source_type });
        if (dry_run) {
          return jsonResult(
            dryRunPreview(`POST /alerts/${source_type}/reset`, { source_type }, {
              source_type,
              affected_count: matching.length,
              sample_uids: matching.slice(0, 10).map((a) => a.uid)
            })
          );
        }
        await ninja.resetAlertsBySource(source_type);
        return jsonResult({ reset_all: true, source_type, affected_count: matching.length });
      }
    );
  }
}
