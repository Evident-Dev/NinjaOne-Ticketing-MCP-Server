// Destructive-operation guardrails.
//
// Layer A — Capability allowlist: tools whose capability key is NOT in
//   config.destructiveAllowlist are skipped during registration. Claude
//   literally cannot see the tool in its catalogue.
//
// Layer B — Confirm token: each destructive tool requires a `confirm` literal
//   the user must speak verbatim. System-prompted: model never auto-fills.
//
// Layer C — Dry-run: every destructive tool accepts `dry_run` and short-
//   circuits to a preview-only response when true.
//
// Layer D — Audit log: NinjaClient.request() writes every non-GET call to the
//   Postgres `audit_log` table (when DATABASE_URL is set).

import { z } from "zod";
import type { AppConfig } from "./config.js";

/** Returns true if `key` is enabled by NINJA_ALLOW_DESTRUCTIVE. */
export function isCapabilityAllowed(config: AppConfig, key: string): boolean {
  return config.destructiveAllowlist.has(key.toLowerCase());
}

/** Builds the `confirm` field that requires the user to type a specific word. */
export function confirmField(word: string, action: string) {
  return z
    .literal(word)
    .describe(
      `Type the word ${word} to confirm — the user must say this themselves. ` +
        `This is a safety gate on a destructive action (${action}). Never auto-fill.`
    );
}

/** Standard dry-run flag — when true, the tool returns a preview without acting. */
export const dryRunField = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "When true, resolves the target and returns what would be sent, without making the destructive call. Recommend running once with dry_run=true so the user can confirm."
  );

export interface DryRunResult<T> {
  dry_run: true;
  would_call: string;
  would_with: T;
  preview: unknown;
}

export function dryRunPreview<T>(label: string, payload: T, preview: unknown): DryRunResult<T> {
  return { dry_run: true, would_call: label, would_with: payload, preview };
}
