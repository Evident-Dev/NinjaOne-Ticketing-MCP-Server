// Per-request context passed through AsyncLocalStorage. Lets MCP tool
// handlers (which only receive their declared input args) reach back and read
// per-connection metadata — specifically, which technician this connection is
// authenticated as, based on the URL token they came in with.

import { AsyncLocalStorage } from "node:async_hooks";

export type AuthMode =
  | { kind: "technician"; email: string; name?: string }
  | { kind: "shared-secret" }
  | { kind: "open" };

export interface RequestContext {
  /** How this request was authenticated. */
  auth: AuthMode;
  /** Optional per-tool override of the technician email. Set by tool handlers
   *  when the caller passes `as_technician_email`. Not used yet but reserved. */
  technicianEmailOverride?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCurrentRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** Run `fn` with the given context active. */
export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return requestContext.run(ctx, fn);
}

/** Resolve the technician email applicable to the current request, in
 *  priority order: explicit tool arg > per-request auth (tech token) >
 *  per-request override > undefined (caller decides fallback). */
export function getRequestTechnicianEmail(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const ctx = getCurrentRequestContext();
  if (ctx?.technicianEmailOverride) return ctx.technicianEmailOverride;
  if (ctx?.auth.kind === "technician") return ctx.auth.email;
  return undefined;
}
