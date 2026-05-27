# NinjaOne MCP Server

A Railway-hosted MCP server that gives Claude full access to NinjaOne — tickets, customers, devices, and alerts — via separate per-domain endpoints so Claude only loads the toolset it needs.

**Version:** 0.4.0
**Status:** v0.4.0 is a ground-up rewrite of the auth layer. Tickets, comments, devices, and alerts now work via pure OAuth 2.0 client-credentials. No per-user OAuth dance.

---

## What changed in 0.4.0

- **Auth is now client_credentials only** — one API app, one set of credentials, works for reads *and* writes (ticket creation, comments, reboots). The old per-user OAuth flow is gone.
- **Split into 5 endpoints** — `/mcp/tickets`, `/mcp/customers`, `/mcp/devices`, `/mcp/alerts`, plus `/mcp` for everything. Add only the slices you need in Claude → smaller tool-schema cost.
- **New domains** — devices (list/get/reboot/activities) and alerts (list/summary/reset).
- **Better error surfacing** — when NinjaOne rejects something, you now see the actual `resultCode` and `errorMessage`.
- **Multi-region** — set `NINJA_REGION` and base URLs are derived. Supports `us, eu, oc, ca, us2, fed`.
- **Automatic 401 retry** — if a token goes stale, we refresh and retry once.

---

## Endpoints

Each endpoint is a separate MCP server. Add only the ones you want in Claude.

| URL | Tools | Use for |
|---|---|---|
| `/mcp` | Everything below (≈22 tools) | Power users, scripted workflows |
| `/mcp/tickets` | Create, get, update, close, comment, log, list-for-board, statuses, forms, boards, attributes (≈12) | Help-desk techs |
| `/mcp/customers` | Find orgs, find by domain, get org, create org, list locations, find contact (≈6) | Account managers, ticket triage |
| `/mcp/devices` | List, get, reboot, activity log (≈4) | Sysadmins, RMM work |
| `/mcp/alerts` | List, summary by severity, reset (≈3) | NOC / monitoring |

Every endpoint also exposes `ninja_status` (connection check) and `ninja_whoami` (technician identity).

---

## Setup

### 1. Create a NinjaOne API app

In the NinjaOne admin console:

1. **Administration → Apps → API → Add** (a "Client App ID").
2. **Application Platform:** `API Services (machine-to-machine)`.
3. **Name:** `Claude MCP` (or anything).
4. **Redirect URIs:** leave blank — we don't use authorization-code flow.
5. **Scopes:** check `monitoring` and `management`. (`control` and `offline_access` not needed.)
6. **Allowed Grant Types:** check `Client Credentials`. Uncheck the others.
7. Save. You'll be shown a **Client ID** and **Client Secret** — copy both somewhere safe. The secret is shown **once**.

**Then grant API permissions** (this is separate from OAuth scopes and is what actually controls what the app can do):

8. Back in the app, find the **API Permissions** / role section. Grant at minimum:
   - **Ticketing:** Create, Read, Update (and Delete if you want close/delete)
   - **Devices:** Read (and Manage if you want reboots)
   - **Organizations:** Read (and Manage if you want to create new orgs from Claude)
   - **Alerts:** Read (and Manage if you want to reset alerts)
9. Save. Permissions changes are usually immediate but can take a minute to propagate.

> **If ticket creation returns `403` with `resultCode: user_context_required`, this is almost always a permissions issue at step 8 — the API app doesn't have ticketing-write permission.** The OAuth scope (`management`) authorizes the token; the API permission on the app role authorizes the action.

### 2. Find your region

NinjaOne tenants are regional. Pick the one that matches the host you log into:

| Region code | Web URL | Use if you log in at… |
|---|---|---|
| `us` | https://app.ninjarmm.com | …app.ninjarmm.com (most US accounts) |
| `eu` | https://eu.ninjarmm.com | …eu.ninjarmm.com |
| `oc` | https://oc.ninjarmm.com | …oc.ninjarmm.com (Oceania/APAC) |
| `ca` | https://ca.ninjarmm.com | …ca.ninjarmm.com (Canada) |
| `us2` | https://us2.ninjarmm.com | …us2.ninjarmm.com |
| `fed` | https://app.ninjaone.us | NinjaOne Federal |

If you're on a partner / whitelabel instance with its own hostname (e.g. `something.rmmservices.net`), skip `NINJA_REGION` and set `NINJA_BASE_URL` to your full hostname instead.

### 3. Deploy to Railway

1. **Fork** this repo (or push it to your own GitHub).
2. In Railway: **New Project → Deploy from GitHub** → pick the repo. Railway detects the Dockerfile and builds automatically.
3. After the first deploy, go to the service's **Settings → Networking** and click **Generate Domain**. Note the public URL (e.g. `https://ninja-mcp-production.up.railway.app`).
4. Go to **Variables** and add:

   | Variable | Required? | Value |
   |---|---|---|
   | `NINJA_CLIENT_ID` | **Yes** | Client ID from step 1 |
   | `NINJA_CLIENT_SECRET` | **Yes** | Client Secret from step 1 |
   | `NINJA_REGION` | Recommended | `us`, `eu`, `oc`, `ca`, `us2`, or `fed` |
   | `MCP_SHARED_SECRET` | **Yes for production** | Any long random string — Claude uses this as a Bearer token to authenticate to the MCP endpoints. Generate one with `openssl rand -hex 32` or any password manager. |
   | `TECHNICIAN_EMAIL` | Optional | Your NinjaOne login email — if set, comments are signed with your name and tickets default to you as assignee |
   | `DEFAULT_TICKET_FORM_ID` | Optional | Numeric ID of your default ticket form. Find it via the `ninja_list_ticket_forms` tool after first connecting. |
   | `NINJA_BASE_URL` | Only for whitelabel | Full base URL if not using a stock region |
   | `NINJA_TOKEN_URL` | Rarely | Explicit OAuth token URL (overrides region) |
   | `NINJA_API_BASE_URL` | Rarely | Explicit API base URL (overrides region) |

5. Redeploy if Railway didn't automatically.
6. Visit `https://<your-domain>/health` — should return `{ ok: true, configured: true, ... }`.
7. Test the NinjaOne connection (replace `<SECRET>`):
   ```
   curl -H "Authorization: Bearer <SECRET>" \
        https://<your-domain>/debug/test-ninja
   ```
   Should return `{ ok: true, orgCount: N, sample: [...] }`.

### 4. Connect from Claude

In Claude (Desktop, Web, or Code) add each MCP server you want. Use the URL plus the shared secret as a Bearer token.

**Claude Desktop / Code config example** (`mcp_servers` in your config):
```json
{
  "mcpServers": {
    "ninja-tickets": {
      "url": "https://<your-domain>/mcp/tickets",
      "headers": { "Authorization": "Bearer <MCP_SHARED_SECRET>" }
    },
    "ninja-customers": {
      "url": "https://<your-domain>/mcp/customers",
      "headers": { "Authorization": "Bearer <MCP_SHARED_SECRET>" }
    }
  }
}
```

**Claude.ai (web) custom MCP connector:** paste the endpoint URL, then add an `Authorization: Bearer <MCP_SHARED_SECRET>` header.

> Add as many or as few endpoints as you want. A help-desk workflow really only needs `tickets` + `customers`. Skipping `devices` and `alerts` saves Claude from loading their tool schemas, which costs tokens on every turn.

---

## Local development

```bash
npm install
cp .env.example .env
# fill in NINJA_CLIENT_ID, NINJA_CLIENT_SECRET, NINJA_REGION
npm run dev
```

The server listens on `http://localhost:3000`. With no `MCP_SHARED_SECRET` set locally, the endpoints are open for testing.

Quick smoke test:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/debug/test-ninja
```

---

## Tool reference

### Tickets (`/mcp/tickets`)

| Tool | Purpose |
|---|---|
| `ninja_create_ticket` | Create a ticket. Org resolution via `organization_id`, `organization_name` (fuzzy), or `organization_domain`. Supports custom fields via `attributes`. |
| `ninja_get_ticket` | Fetch a ticket by ID. |
| `ninja_update_ticket` | Update any combination of subject/status/priority/severity/type/assignee/tags/attributes; optional `comment_body`. |
| `ninja_close_ticket` | Convenience: set status to CLOSED, optionally with a final comment. |
| `ninja_add_comment` | Public reply or internal note; optional `time_tracked` in seconds. |
| `ninja_get_ticket_log` | Full comment + activity history. |
| `ninja_list_tickets_for_board` | Tickets on a specific board. |
| `ninja_list_ticket_forms` | Discover ticket forms. |
| `ninja_list_ticket_boards` | Discover boards. |
| `ninja_list_ticket_statuses` | Discover statuses + their IDs. |
| `ninja_list_ticket_attributes` | Discover custom fields. |

### Customers (`/mcp/customers`)

| Tool | Purpose |
|---|---|
| `ninja_find_organizations` | Fuzzy search by name. |
| `ninja_find_org_by_domain` | Look up org from `acme.com` (or `user@acme.com`). |
| `ninja_get_organization` | Org details by ID. |
| `ninja_list_organization_locations` | Locations belonging to an org. |
| `ninja_create_organization` | Create a new customer org. |
| `ninja_find_contact` | Search contacts by name/email; returns UIDs needed as ticket requesters. |

### Devices (`/mcp/devices`)

| Tool | Purpose |
|---|---|
| `ninja_list_devices` | List devices; optional `organization_id` filter. |
| `ninja_get_device` | Device details by ID. |
| `ninja_device_activities` | Recent device activity log. |
| `ninja_reboot_device` | Schedule reboot (`NORMAL` or `FORCED`). Destructive — Claude confirms first. |

### Alerts (`/mcp/alerts`)

| Tool | Purpose |
|---|---|
| `ninja_list_alerts` | All active alerts; optional `device_id` or `source_type`. |
| `ninja_alerts_summary` | Count grouped by severity. |
| `ninja_reset_alert` | Dismiss a single alert by UID. |

### Always available

| Tool | Purpose |
|---|---|
| `ninja_status` | Connection + region + scope check. |
| `ninja_whoami` | Technician identity (from `TECHNICIAN_EMAIL`). |

---

## Troubleshooting

**`401 Unauthorized` from `/mcp/...`**
You forgot to send the `Authorization: Bearer <MCP_SHARED_SECRET>` header, or it doesn't match the env var.

**`NinjaOne token request failed (401)` in logs**
Wrong `NINJA_CLIENT_ID` / `NINJA_CLIENT_SECRET`, wrong region, or the API app doesn't have **Client Credentials** as an allowed grant type.

**Ticket create returns `403` with `user_context_required`**
The API app is missing the **Ticketing → Create/Update** permission. Go back to step 1.8 in setup and grant it. This is a permission on the app role, not the OAuth scope.

**Ticket create returns `400` with a field complaint**
Now that errors are surfaced properly, the response body tells you which field NinjaOne is unhappy with. Common ones:
- `priority` must be one of `NONE | LOW | MEDIUM | HIGH`
- `severity` must be one of `NONE | MINOR | MODERATE | MAJOR | CRITICAL`
- `status` must be a known status name or numeric ID (use `ninja_list_ticket_statuses`)
- Custom attributes must use the attribute IDs from `ninja_list_ticket_attributes`

**Reads work but writes don't, even with permissions**
Double-check that your API app's allowed scopes include `management` (not just `monitoring`). `monitoring` is read-only.

**`Multiple organizations matched 'Acme'`**
The org name is ambiguous. Use `ninja_find_organizations` to see options and call `ninja_create_ticket` with the explicit `organization_id`.

**Whitelabel / partner instance**
If your NinjaOne hostname isn't on the regional list, leave `NINJA_REGION` unset and set `NINJA_BASE_URL` (e.g. `https://something.rmmservices.net`) — token and API URLs are derived from it.

---

## Architecture

- One Node process serves all endpoints.
- One shared `NinjaClient` (in `src/ninja.ts`) handles token caching, 401 retry, and request-level errors.
- Each `/mcp/<slice>` endpoint builds a fresh `McpServer` per request and registers only that slice's tool set. Stateless. No cross-request session bookkeeping.
- The OAuth token is cached in memory, preemptively refreshed 2 minutes before expiry, and concurrent acquisitions are deduplicated.

```
src/
  index.ts          ← Express app, endpoint routing
  config.ts         ← env vars + region → URL derivation
  types.ts          ← shared types
  ninja.ts          ← NinjaClient (HTTP + auth + cache)
  domains/
    common.ts       ← DomainContext + jsonResult helper
    status.ts       ← ninja_status, ninja_whoami (every endpoint)
    tickets.ts      ← ticket tools
    customers.ts    ← organization + contact tools
    devices.ts      ← device tools
    alerts.ts       ← alert tools
```

---

## License

MIT
