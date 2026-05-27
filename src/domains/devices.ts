import { z } from "zod";
import { jsonResult, type DomainContext } from "./common.js";

export function registerDevicesDomain({ server, ninja }: DomainContext): void {
  server.registerTool(
    "ninja_list_devices",
    {
      title: "List Devices",
      description: "List devices, optionally filtered by organization. Read-only.",
      inputSchema: z.object({
        organization_id: z.coerce.number().int().positive().optional(),
        page_size: z.number().int().min(1).max(1000).default(100),
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
    "ninja_get_device",
    {
      title: "Get Device",
      description: "Get a single device by ID.",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id }) => jsonResult(await ninja.getDevice(device_id))
  );

  server.registerTool(
    "ninja_device_activities",
    {
      title: "Device Activity Log",
      description: "Recent activity log entries for a device (alerts, jobs, status changes).",
      inputSchema: z.object({
        device_id: z.coerce.number().int().positive(),
        page_size: z.number().int().min(1).max(500).default(50)
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ device_id, page_size }) => jsonResult(await ninja.getDeviceActivities(device_id, page_size))
  );

  server.registerTool(
    "ninja_reboot_device",
    {
      title: "Reboot Device",
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
}
