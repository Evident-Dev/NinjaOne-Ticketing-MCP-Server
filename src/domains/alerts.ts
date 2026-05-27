import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerAlertsDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_list_alerts",
    {
      title: "List Alerts",
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
    "ninja_alerts_summary",
    {
      title: "Alert Summary by Severity",
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
    "ninja_reset_alert",
    {
      title: "Reset Alert",
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
}
