import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";
import { confirmField, dryRunField, dryRunPreview, isCapabilityAllowed } from "../guardrails.js";

export function registerDevicesDomain({ server, ninja, config }: DomainContext): void {
  // ── Core reads ─────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_device_list",
    {
      title: "Device: List",
      description: "List devices, optionally filtered by organization. Read-only.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive().optional(),
        page_size: z.coerce.number().int().min(1).max(1000).default(100),
        device_filter: z.string().optional().describe("Raw NinjaOne device filter (df=) — power users only")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ organization_id, page_size, device_filter }) => {
      const devices = await ninja.listDevices({
        organizationId: organization_id,
        pageSize: page_size,
        deviceFilter: device_filter
      });
      return jsonResult({ count: devices.length, devices });
    }
  );

  server.registerTool(
    "ninja_device_get",
    {
      title: "Device: Get",
      description: "Get a single device by ID.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDevice(device_id))
  );

  server.registerTool(
    "ninja_device_list_activities",
    {
      title: "Device: List Activities",
      description: "Recent activity log entries for a device (alerts, jobs, status changes).",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive(),
        page_size: z.coerce.number().int().min(1).max(500).default(50)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id, page_size }) => jsonResult(await ninja.getDeviceActivities(device_id, page_size))
  );

  // ── Detail expanders (Tier 1) ─────────────────────────────────────────────

  server.registerTool(
    "ninja_device_list_software",
    {
      title: "Device: Installed Software",
      description: "List installed software inventory for a device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceSoftware(device_id))
  );

  server.registerTool(
    "ninja_device_list_os_patches",
    {
      title: "Device: OS Patches",
      description: "List operating-system patch status for a device (installed, pending, failed).",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceOsPatches(device_id))
  );

  server.registerTool(
    "ninja_device_list_disks",
    {
      title: "Device: Disks",
      description: "List physical disks for a device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceDisks(device_id))
  );

  server.registerTool(
    "ninja_device_list_volumes",
    {
      title: "Device: Volumes",
      description: "List logical volumes / drives (with free space) for a device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceVolumes(device_id))
  );

  server.registerTool(
    "ninja_device_list_processors",
    {
      title: "Device: Processors",
      description: "List CPU info for a device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceProcessors(device_id))
  );

  server.registerTool(
    "ninja_device_list_services",
    {
      title: "Device: Windows Services",
      description: "List Windows services and their states for a device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceServices(device_id))
  );

  server.registerTool(
    "ninja_device_last_logged_on_user",
    {
      title: "Device: Last Logged-On User",
      description: "Return the most recent user account that logged on to this device.",
      inputSchema: z.object({ device_id: z.coerce.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDeviceLastLoggedOnUser(device_id))
  );

  // ── Writes ────────────────────────────────────────────────────────────────

  server.registerTool(
    "ninja_device_reboot",
    {
      title: "Device: Reboot",
      description: "Schedule a reboot for a device. DESTRUCTIVE — confirm with the user first.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive(),
        mode: z.enum(["NORMAL", "FORCED"]).default("NORMAL"),
        reason: z.string().max(500).optional()
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ device_id, mode, reason }) => {
      await ninja.rebootDevice(device_id, mode, reason);
      return jsonResult({ scheduled: true, device_id, mode, reason: reason ?? null });
    }
  );

  server.registerTool(
    "ninja_device_set_maintenance",
    {
      title: "Device: Set Maintenance Window",
      description:
        "Place a device into maintenance mode for a duration (suppresses alerts). Pass end_unix_ms; optional start_unix_ms (defaults to now). disabled_features defaults to alerts only.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive(),
        end_unix_ms: z.coerce.number().int().positive().describe("Maintenance window end, unix ms"),
        start_unix_ms: z.coerce.number().int().positive().optional().describe("Defaults to now if omitted"),
        disabled_features: z
          .array(z.enum(["ALERTS", "PATCHING", "AVSCANS", "TASKS"]))
          .min(1)
          .default(["ALERTS"])
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id, end_unix_ms, start_unix_ms, disabled_features }) => {
      await ninja.setDeviceMaintenance(device_id, {
        end: end_unix_ms,
        start: start_unix_ms,
        disabledFeatures: disabled_features
      });
      return jsonResult({ ok: true, device_id, until_unix_ms: end_unix_ms, disabled_features });
    }
  );

  server.registerTool(
    "ninja_device_clear_maintenance",
    {
      title: "Device: Clear Maintenance Window",
      description: "Remove any active maintenance window on a device.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => {
      await ninja.clearDeviceMaintenance(device_id);
      return jsonResult({ ok: true, device_id, maintenance: "cleared" });
    }
  );

  // ── Destructive: gated by NINJA_ALLOW_DESTRUCTIVE=device_delete ──────────
  if (isCapabilityAllowed(config, "device_delete")) {
    server.registerTool(
      "ninja_device_delete",
      {
        title: "Device: DELETE (permanent)",
        description:
          "Permanently remove a device from NinjaOne. IRREVERSIBLE. Requires confirm=\"DELETE\" — the user must say this word themselves; never auto-fill. Strongly recommend running with dry_run=true first.",
        inputSchema: z.object({
          device_id: z.coerce.number().int().positive(),
          confirm: confirmField("DELETE", "permanent device removal"),
          dry_run: dryRunField
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ device_id, dry_run }) => {
        const target = await ninja.getDevice(device_id);
        if (dry_run) {
          return jsonResult(
            dryRunPreview(`DELETE /device/${device_id}`, { device_id }, {
              device_id,
              system_name: target.systemName,
              display_name: target.displayName,
              organization_id: target.organizationId
            })
          );
        }
        await ninja.deleteDevice(device_id);
        return jsonResult({ deleted: true, device_id, deleted_device: target });
      }
    );
  }
}
