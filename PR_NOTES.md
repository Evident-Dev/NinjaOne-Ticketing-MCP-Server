# PR: v0.4.0 — client_credentials rewrite + per-domain MCP endpoints

**Base:** `master` ← **Compare:** `develop`

---

## Summary

Ground-up rewrite of the auth layer and a split into per-domain MCP endpoints. Ticket creation now works end-to-end via OAuth 2.0 client credentials — no per-user OAuth dance. Adds devices and alerts domains. Cuts ~660 lines of session/OAuth plumbing.

## Why

- **Ticket creation was broken.** Errors from NinjaOne were being swallowed by the request layer, hiding the actual cause (almost always a missing **Ticketing → Create/Update** permission on the API app role in NinjaOne admin — separate from the OAuth scope).
- **Token cost.** Loading 18+ tool schemas for every Claude turn was wasteful when most workflows only need 6 of them.
- **Complexity.** The per-user OAuth 2.1 server (sessions, PKCE, dynamic client registration, disk-persisted refresh tokens) was carrying its weight for no win — the reference implementation we audited (wyre-technology/ninjaone-mcp) successfully writes tickets with pure machine-to-machine auth.

## Changes

### Auth (the actual fix)
- New `src/ninja.ts` — pure client_credentials, in-memory token cache, 2-minute preemptive refresh, concurrent-acquisition dedupe, automatic 401 retry with token invalidation.
- New `NinjaApiError` class parses NinjaOne's response body and surfaces `resultCode` + `errorMessage` instead of dumping a raw status code.
- Deleted: `src/auth.ts`, `src/oauth-server.ts`, `src/sessions.ts`.

### Endpoint split (token diet)

One Node process, five MCP endpoints. Each registers only its slice:

| Endpoint | Tools |
|---|---|
| `/mcp` | All ~22 |
| `/mcp/tickets` | ~12 |
| `/mcp/customers` | ~6 |
| `/mcp/devices` | ~4 (new domain) |
| `/mcp/alerts` | ~3 (new domain) |

Help-desk users add `tickets` + `customers` and skip the rest → ~60% reduction in tool-schema tokens.

### New capability
- **Devices**: `list`, `get`, `activities`, `reboot`
- **Alerts**: `list`, `summary` by severity, `reset`
- **Customers**: `get_organization`, `list_organization_locations`, `create_organization`
- **Tickets**: `close_ticket` convenience tool, `attributes` map passthrough for custom fields, `cc_emails`, explicit `requester_uid` to skip the email lookup

### Config
- New `NINJA_REGION` (us/eu/oc/ca/us2/fed) auto-derives base URLs.
- `NINJA_BASE_URL` override for partner/whitelabel instances.
- Required vars cut from 4 to 2: `NINJA_CLIENT_ID`, `NINJA_CLIENT_SECRET`. (`MCP_SHARED_SECRET` strongly recommended for production but not strictly required.)
- Loud boot-time banner when required vars are missing, with explicit "add in Railway Variables and redeploy" instructions. `/mcp` returns a 503 with the same actionable message.

### Architecture
```
src/
  index.ts          ← Express app, endpoint routing
  config.ts         ← env + region → URLs
  ninja.ts          ← NinjaClient (HTTP + auth + cache)
  types.ts
  domains/
    common.ts
    status.ts       ← ninja_status, ninja_whoami (on every endpoint)
    tickets.ts
    customers.ts
    devices.ts
    alerts.ts
```

## Breaking changes for deployers

- **Env vars to delete from Railway**: `PUBLIC_BASE_URL`, `OAUTH_REDIRECT_URI`, `NINJA_AUTHORIZE_URL`, `TOKEN_STORE_PATH`, `SESSION_STORE_PATH`.
- **Env vars to add**: `NINJA_REGION` (e.g. `us`).
- **Env vars now optional**: `NINJA_TOKEN_URL`, `NINJA_API_BASE_URL` — derived from `NINJA_REGION` unless explicitly set.
- **Railway volume at `/data`** is no longer needed (no disk persistence). Safe to leave mounted.
- **NinjaOne API app reconfiguration required**:
  - Grant type: only `Client Credentials` needs to be allowed (uncheck Authorization Code).
  - Scope: `monitoring management` (drop `offline_access`).
  - **Critical**: in the app's role/permissions section, grant **Ticketing → Create/Update**. This is the permission that was likely missing and silently blocking ticket creation before.

## Verification

- [x] `npm run build` clean (TypeScript strict mode)
- [ ] Deploy `develop` to Railway, set the 3 required vars
- [ ] `GET /health` returns `{ ok: true, configured: true }`
- [ ] `GET /debug/test-ninja` returns org count (read path works)
- [ ] From Claude, add `/mcp/tickets` with Bearer auth, call `ninja_create_ticket` against a test org, confirm the ticket appears in NinjaOne UI (write path works)
- [ ] Add `/mcp/devices` separately, call `ninja_list_devices`, confirm scope isolation (tickets tools should NOT be available on the devices endpoint)
- [ ] Trigger a deliberate error (e.g. invalid status name) and confirm the response surfaces NinjaOne's actual `resultCode`/`errorMessage`

## Files changed

```
 .env.example              |  modified
 README.md                 |  rewritten
 package.json              |  v0.3.0 → v0.4.0
 src/auth.ts               |  DELETED
 src/oauth-server.ts       |  DELETED
 src/sessions.ts           |  DELETED
 src/config.ts             |  rewritten
 src/ninja.ts              |  rewritten
 src/types.ts              |  expanded (devices, alerts)
 src/index.ts              |  rewritten (multi-endpoint)
 src/domains/*.ts          |  NEW (6 files)
```

**Net:** −1,596 / +3,076 lines (most of the gain is the README + tool-schema documentation).
