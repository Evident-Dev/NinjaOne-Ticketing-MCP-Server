# NinjaOne MCP Server

A Railway-hosted MCP server that gives Claude full access to NinjaOne — tickets, customers, devices, and alerts — via separate per-domain endpoints so Claude only loads the toolset it needs.

**Version:** 0.9.0

## What changed in 0.9.0

- **Two new endpoints.** `/mcp/billing` (contracts, invoices, products, ticket-products) and `/mcp/security` (vulnerability triage). See the endpoints table below.
- **Billing domain.** Read contracts/invoices/products/customer-accounts, list ticket-products, and add billable time/products to a ticket — closes the time-tracking → invoice loop. New convenience tool `ninja_ticket_add_billable_time` for hours/minutes-based billing from the tickets endpoint.
- **Vulnerability triage.** `ninja_vuln_list` (with org/severity filter), `ninja_vuln_get` by CVE, `ninja_vuln_list_for_device`.
- **Device detail expanders.** `software`, `os_patches`, `disks`, `volumes`, `processors`, `services`, `last_logged_on_user` — everything you need to diagnose a machine from chat.
- **Maintenance windows.** `ninja_device_set_maintenance` / `clear_maintenance` to suppress alerts during work.
- **Technician lookup.** `ninja_user_list` and `ninja_user_find` so Claude can resolve "assign to <person>" → appUserId.
- **Cross-domain helpers per endpoint.** `/mcp/tickets` now includes user + device lookup. `/mcp/customers` includes devices + billing. Each slice is self-sufficient — no endpoint-hopping for common workflows.
- **Destructive-op guardrails.** Four-layer framework:
  - **Allowlist (`NINJA_ALLOW_DESTRUCTIVE`).** Destructive tools whose capability key isn't in this CSV are not registered — Claude literally can't see them.
  - **Confirm token.** `ninja_ticket_delete` / `ninja_device_delete` / `ninja_alert_reset_all` require the user to type `DELETE` / `RESET` themselves.
  - **Dry-run.** Every gated tool accepts `dry_run: true` to preview the target + payload without acting.
  - **Audit log.** A new Postgres `audit_log` table records every non-GET request (actor, method, path, status, result_code, payload summary). Queryable in Railway → Postgres → Data.
- **Better error surfacing.** `NinjaApiError` parses `resultCode` + `errorMessage` from NinjaOne JSON bodies, so 4xx failures are debuggable from Claude.
- **`/health` reports `destructive_allowlist`** so you can verify the env-var took effect without restarting Claude.

Capability keys for `NINJA_ALLOW_DESTRUCTIVE`:
- `ticket_delete` — recommended
- `alert_reset_all` — recommended
- `device_delete` — leave off unless you really need it

## What changed in 0.8.0

- **Tool naming convention.** Every tool renamed to `ninja_<resource>_<action>` for consistency and easier discovery (e.g. `ninja_create_ticket` → `ninja_ticket_create`, `ninja_list_alerts` → `ninja_alert_list`).
- Tool descriptions tightened so Claude picks the right tool faster.

## What changed in 0.7.0

- **DB-backed technician registry.** Attach a Railway Postgres to the service and the MCP server takes over: on every boot (and every 15 minutes thereafter, and on any auth-miss) it pulls technicians from NinjaOne `/users`, inserts new ones into a `technicians` table, and auto-generates a personal token for each. No env-var bookkeeping when new techs join.
- **Tokens visible in the Railway DB browser.** Admin opens the `technicians` table and copies tokens to hand out. No secret-printing in logs.
- **Backward compatible** — if `DATABASE_URL` isn't set, the old `NINJA_TECHNICIANS` env-var allowlist still works.

## What changed in 0.6.0

- **Per-technician tokens** (URL-based) so multi-tech teams can share one deployment.
- **Identity from URL, not headers** — works with Claude.ai's custom-connector UI.
- **`ninja_whoami` reports identity source** — `url-token`, `config`, or `none`.

---

## What changed in 0.5.0

- **Auth model fixed for ticket writes.** NinjaOne's ticket-create / comment / update endpoints physically require a user-context OAuth token (we verified this against the API and confirmed it via two reference implementations in the wild). v0.4.0's pure machine-token approach could read but never write. v0.5.0 uses a hybrid:
  - **Reads** (orgs, devices, alerts, lookups): machine token, no login needed.
  - **Writes** (ticket create, comment, update, close, reboot): user-context token from a one-time browser login. The token is then refreshed automatically forever.
- **Refresh-token rotation done correctly.** NinjaOne issues a new refresh token on every refresh; the old one dies instantly. v0.5.0 persists the rotated token to disk via atomic write *before* returning the access token to the caller, so a crash mid-flow can't lock you out. This was almost certainly the bug that quietly broke v0.3.0's per-user OAuth flow.
- **Background keepalive.** Every 12 hours the server refreshes the token even if nothing's been calling it, so the refresh chain stays warm during quiet periods.
- **Clear "login required" UX.** When Claude tries to write and there's no user token, the tool returns a structured error that includes the sign-in URL and tells Claude to ask the user to visit it. New `ninja_auth_status` tool so Claude can self-diagnose.
- **Loud boot banner** if user login is missing. No silent failures.

## What carried over from 0.4.0

- **Split into 5 endpoints** — `/mcp/tickets`, `/mcp/customers`, `/mcp/devices`, `/mcp/alerts`, plus `/mcp` for everything.
- **Devices and alerts domains** — list/get/reboot/activities, list/summary/reset.
- **Multi-region** — `NINJA_REGION` (us/eu/oc/ca/us2/fed) derives base URLs.
- **NinjaApiError with parsed resultCode/errorMessage** so failures are debuggable.

---

## Endpoints

Each endpoint is a separate MCP server. Add only the ones you want in Claude.

Each endpoint also ships the **Core Lookup Pack** (`ninja_system_status`, `ninja_system_whoami`, `ninja_system_auth_status`, `ninja_org_find`, `ninja_org_find_by_domain`, `ninja_org_get`, `ninja_org_list_locations`, `ninja_contact_find`) so any workflow can resolve "the customer the user mentioned by name" without changing endpoints.

| URL | Domain-specific tools added | Cross-domain helpers included | Use for |
|---|---|---|---|
| `/mcp` | Everything | — | Power users, scripted workflows |
| `/mcp/tickets` | Ticket CRUD + comment + resolve + add_billable_time + (gated) delete + list forms/boards/statuses/attributes | user lookup, device read | Help-desk techs |
| `/mcp/customers` | Org create + locations | device list, billing read | Account managers, intake |
| `/mcp/devices` | Get, list, reboot, activities, software, os_patches, disks, volumes, processors, services, last_logged_on_user, maintenance, (gated) delete | alert list | Sysadmins, RMM work |
| `/mcp/alerts` | List, summary, reset, (gated) reset_all | device read | NOC / monitoring |
| `/mcp/billing` | Agreements, invoices, products, customer accounts, ticket products, add_ticket_product | ticket read, user lookup | Finance, account managers |
| `/mcp/security` | Vulnerabilities (list / get by CVE / by device) | device read | Security triage |

Each slice is self-sufficient — a help-desk tech adding `/mcp/tickets` can also resolve a customer by name, find a device to attach, and pick an assignee, without needing the full `/mcp` surface.

---

## Setup

### 1. Create a NinjaOne API app

In the NinjaOne admin console: **Administration → Apps → API → Client app IDs → + Add client app**.

> **Important:** v0.5.0 needs a **Web application** platform app (NOT "API Services / machine-to-machine"). The Web platform is the only one that exposes the `offline_access` scope, which is what NinjaOne requires to issue refresh tokens for the one-time sign-in flow.

Fill it in:

1. **Application Platform:** `Web` (or whichever option exposes `offline_access` in the Scopes list — it should be the only non-M2M option).
2. **Name:** anything (e.g. `Beardman MCP Server`).
3. **Redirect URIs:** **`https://<your-railway-domain>/auth/callback`** — replace `<your-railway-domain>` with your actual Railway public URL. You can generate the Railway domain first (step 3 below) and come back to enter this. Required by NinjaOne and must match exactly.
4. **Scopes:** check **Monitoring**, **Management**, and **offline_access**. (Control is optional.)
5. **Allowed Grant Types:** check **Authorization Code**, **Client Credentials**, and **Refresh Token**. All three.
   - *Authorization Code* — for the one-time browser sign-in
   - *Client Credentials* — for fast machine-token reads (orgs, devices, etc.)
   - *Refresh Token* — keeps the sign-in alive indefinitely
6. Click **Add**. You'll be shown the **Client ID** and **Client Secret** — copy both somewhere safe. The secret is shown **once**.

**Then grant API permissions** on the app's role (this is separate from OAuth scopes and is what actually controls what the app can do):

7. In the app or under **Administration → Apps → API → Roles**, grant the role that this app uses at minimum:
   - **Ticketing:** Create, Read, Update (and Delete if you want close/delete)
   - **Devices:** Read (and Manage if you want reboots)
   - **Organizations:** Read (and Manage if you want to create new orgs from Claude)
   - **Alerts:** Read (and Manage if you want to reset alerts)
8. Save.

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
3. **Generate a public domain** at **Settings → Networking → Generate Domain**. Note the URL (e.g. `https://ninja-mcp-production.up.railway.app`). Go back to your NinjaOne API app and paste `https://<domain>/auth/callback` into the Redirect URIs field.
4. **Mount a Railway Volume** at `/data`. This is where the refresh token is persisted. Without it, the token is wiped on every redeploy and you'll have to sign in again each time.
   - **Settings → Volumes → New Volume** → mount path `/data` → 100 MB is plenty.
5. Go to **Variables** and add:

   | Variable | Required? | Value |
   |---|---|---|
   | `NINJA_CLIENT_ID` | **Yes** | Client ID from step 1 |
   | `NINJA_CLIENT_SECRET` | **Yes** | Client Secret from step 1 |
   | `NINJA_REGION` | Recommended | `us`, `eu`, `oc`, `ca`, `us2`, or `fed` |
   | `MCP_SHARED_SECRET` | **Yes for production** | Long random string. Used for `/mcp/*` Bearer auth AND as the `?token=` query param on `/auth/login`. Generate with `openssl rand -hex 32`. |
   | `TECHNICIAN_EMAIL` | Optional | Your NinjaOne login email — comments are signed with your display name and tickets default to you as assignee |
   | `DEFAULT_TICKET_FORM_ID` | Optional | Numeric ID of your default ticket form. Find it via the `ninja_list_ticket_forms` tool after sign-in. |
   | `PUBLIC_BASE_URL` | Auto | Railway sets `RAILWAY_PUBLIC_DOMAIN` automatically once a domain is generated — we derive the base URL from it. Only set this manually if you need to override. |
   | `USER_TOKEN_PATH` | Default `/data/refresh-token.json` | Path inside the container where the refresh token is persisted. Must be inside a mounted volume. |
   | `NINJA_BASE_URL` | Only for whitelabel | Full base URL if not using a stock region |
   | `NINJA_ALLOW_DESTRUCTIVE` | Optional | CSV of destructive-tool capability keys to enable. Empty = no destructive tools. Recommended: `ticket_delete,alert_reset_all`. Add `device_delete` only if you really need it. |

6. Redeploy if Railway didn't automatically.

### 4. Sign in to NinjaOne (one-time)

After deploy:

1. Visit `https://<your-domain>/health` — should show `{ ok: true, configured: true }`.
2. **Open this URL in a browser** (replace `<SECRET>` with your `MCP_SHARED_SECRET`):
   ```
   https://<your-domain>/auth/login?token=<SECRET>
   ```
3. You'll be redirected to NinjaOne's consent screen. Sign in with your normal NinjaOne account, approve.
4. NinjaOne redirects back; you'll see a "Connected to NinjaOne ✓" page.
5. The refresh token is now persisted at `/data/refresh-token.json` and will be auto-renewed forever.

Verify by visiting (in a browser or with curl):
```
https://<your-domain>/auth/status?token=<SECRET>
```
You should see `{ "authenticated": true, "saved_at": "...", ... }`.

**Re-authentication:** rare. The background keepalive refreshes the token every 12 hours, so as long as the server stays up the token never expires. If NinjaOne ever invalidates it (e.g. you revoke API access), the next write will fail with a clear "re-authorize" message and you just visit `/auth/login` again.

### 5. (Multi-tech only) Set up the technician registry

Skip this if you're a one-person shop — the `MCP_SHARED_SECRET` + `TECHNICIAN_EMAIL` from earlier works fine.

For a team, you have two options:

#### Option A — DB-backed (recommended)

1. **In Railway → your project → + New → Database → Postgres.**
2. Attach it to the MCP service. Railway auto-injects `DATABASE_URL` as an env var.
3. Redeploy. The boot logs will show:
   ```
   [tech-store] DB schema ready (table: technicians)
   [tech-store] DB mode: 7 technician(s) registered, 7 new
   [tech-store] view the new tokens in Railway → Postgres → Data → technicians
   ```
4. **Open Railway → Postgres service → Data tab → `technicians` table** to see each tech's auto-generated token. Hand them out privately.
5. New techs added in NinjaOne automatically get a row + token within 15 minutes of being added (or instantly the first time they try to use a token).

#### Option B — Static env-var allowlist (DB-less)

If you don't want a database, set `NINJA_TECHNICIANS` instead. JSON or CSV:

```json
[
  {"email":"alice@beardmangroup.com","token":"tok_alice_xxx","name":"Alice"},
  {"email":"bob@beardmangroup.com","token":"tok_bob_xxx","name":"Bob"}
]
```

Generate tokens with `openssl rand -hex 24`. Updating the team = editing the env var + redeploying.

The token IS the identity in both modes — it's a personal API key, not cryptographically authenticated. Treat it like a password.

### 6. Connect from Claude

In Claude (Desktop, Web, or Code) add each MCP server you want. Use the URL plus the shared secret as a Bearer token.

**Single-tech (MCP_SHARED_SECRET) — Claude Desktop / Code:**
```json
{
  "mcpServers": {
    "ninja-tickets": {
      "url": "https://<your-domain>/mcp/tickets",
      "headers": { "Authorization": "Bearer <MCP_SHARED_SECRET>" }
    }
  }
}
```

**Multi-tech (per-tech tokens) — each tech adds their personal URL:**
```json
{
  "mcpServers": {
    "ninja-tickets": {
      "url": "https://<your-domain>/mcp/tickets?token=<YOUR_PERSONAL_TOKEN>"
    }
  }
}
```
No `Authorization` header needed — the token goes in the URL as `?token=...`.

**Claude.ai (web) custom connector:**
- **Name:** "NinjaOne Tickets" (or whatever).
- **Remote MCP server URL:** `https://<your-domain>/mcp/tickets?token=<YOUR_PERSONAL_TOKEN>`
- Leave OAuth fields blank.

Each tech's URL only authorizes them as themselves — comments and assignments are attributed to their NinjaOne user. Sharing the URL = impersonation, so treat the token like a password.

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

> Tools follow the convention `ninja_<resource>_<action>` (since v0.8.0). Pre-0.8.0 names are gone.

### Tickets

| Tool | Purpose |
|---|---|
| `ninja_ticket_create` | Create a ticket. Org resolution via `organization_id`, `organization_name` (fuzzy), or `organization_domain`. Supports custom fields via `attributes`. |
| `ninja_ticket_get` | Fetch a ticket by ID. |
| `ninja_ticket_update` | Update any combination of subject/status/priority/severity/type/assignee/tags/attributes; optional `comment_body`. |
| `ninja_ticket_resolve` | Convenience: set status to RESOLVED, optionally with a final comment. NinjaOne treats CLOSED as terminal-only — use RESOLVED. |
| `ninja_ticket_add_comment` | Public reply or internal note; optional `time_tracked` in seconds. |
| `ninja_ticket_add_billable_time` | Log billable time (hours or minutes) on a ticket — wraps `add_ticket_product`. |
| `ninja_ticket_get_log` | Full comment + activity history. |
| `ninja_ticket_list_for_board` | Tickets on a specific board. |
| `ninja_ticket_list_forms` / `_boards` / `_statuses` / `_attributes` | Discover ticket metadata. |
| `ninja_ticket_delete` *(gated by `ticket_delete`)* | Permanent delete with confirm token + dry-run. |

### Customers

| Tool | Purpose |
|---|---|
| `ninja_org_find` | Fuzzy search by name. |
| `ninja_org_find_by_domain` | Look up org from `acme.com` (or `user@acme.com`). |
| `ninja_org_get` | Org details by ID. |
| `ninja_org_list_locations` | Locations belonging to an org. |
| `ninja_org_create` | Create a new customer org. |
| `ninja_contact_find` | Search contacts by name/email; returns UIDs needed as ticket requesters. |

### Devices

| Tool | Purpose |
|---|---|
| `ninja_device_list` | List devices; optional `organization_id` filter. |
| `ninja_device_get` | Device details by ID. |
| `ninja_device_list_activities` | Recent device activity log. |
| `ninja_device_list_software` / `_os_patches` / `_disks` / `_volumes` / `_processors` / `_services` | Inventory + diagnostics. |
| `ninja_device_last_logged_on_user` | Most recent interactive login. |
| `ninja_device_reboot` | Schedule reboot (`NORMAL` or `FORCED`). |
| `ninja_device_set_maintenance` / `_clear_maintenance` | Suppress alerts during a work window. |
| `ninja_device_delete` *(gated by `device_delete`)* | Permanent delete with confirm token + dry-run. |

### Alerts

| Tool | Purpose |
|---|---|
| `ninja_alert_list` | All active alerts; optional `device_id` or `source_type`. |
| `ninja_alert_summary` | Count grouped by severity. |
| `ninja_alert_reset` | Dismiss a single alert by UID. |
| `ninja_alert_reset_all` *(gated by `alert_reset_all`)* | Bulk reset by source type, with confirm token + dry-run. |

### Billing

| Tool | Purpose |
|---|---|
| `ninja_billing_list_agreements` / `get_agreement` | Contracts. |
| `ninja_billing_list_invoices` / `get_invoice` | Invoices. |
| `ninja_billing_list_products` | Product catalogue (use IDs in `add_ticket_product`). |
| `ninja_billing_list_customer_accounts` | Customer billing accounts. |
| `ninja_billing_list_ticket_products` | Billable lines already attached to tickets. |
| `ninja_billing_add_ticket_product` | Attach a billable product/charge to a ticket. |

### Security / Vulnerabilities

| Tool | Purpose |
|---|---|
| `ninja_vuln_list` | List vulnerabilities; optional org + severity filter. |
| `ninja_vuln_get` | Get by CVE identifier. |
| `ninja_vuln_list_for_device` | Per-device exposure. |

### Users (technicians)

| Tool | Purpose |
|---|---|
| `ninja_user_list` | Technicians (or include end users). |
| `ninja_user_find` | Search by name/email; returns `appUserId` for ticket assignment. |

### Always available (on every endpoint)

| Tool | Purpose |
|---|---|
| `ninja_system_status` | Connection + region + scope check. |
| `ninja_system_whoami` | Technician identity. |
| `ninja_system_auth_status` | User-OAuth status + login URL. |

---

## Troubleshooting

**`401 Unauthorized` from `/mcp/...`**
You forgot to send the `Authorization: Bearer <MCP_SHARED_SECRET>` header, or it doesn't match the env var.

**Ticket create returns "No NinjaOne user-context login on file"**
You haven't done the one-time browser sign-in yet. Open `/auth/login?token=<MCP_SHARED_SECRET>` and complete it. After that, ticket writes will work indefinitely.

**Ticket create returns "NinjaOne refresh-token exchange failed"**
Your refresh token expired or was revoked. Re-do the browser sign-in at `/auth/login?token=<MCP_SHARED_SECRET>`.

**Token vanishes on every redeploy**
You don't have a Railway Volume mounted at `/data`. Add one (Settings → Volumes → New Volume → mount path `/data`). The token will then survive redeploys.

**`NinjaOne client_credentials request failed (401)` in logs**
Wrong `NINJA_CLIENT_ID` / `NINJA_CLIENT_SECRET`, wrong region, or the API app doesn't have **Client Credentials** ticked under Allowed Grant Types. Reads will fall back to user-context (which works after sign-in), so this isn't always fatal.

**Browser sign-in errors with "No refresh_token in response"**
The API app doesn't have `offline_access` in its scopes. Re-check the app config — must be a Web platform app (not API Services / M2M), with `offline_access` ticked.

**Browser sign-in errors with NinjaOne "invalid_redirect_uri"**
The Redirect URI on your NinjaOne API app doesn't exactly match `https://<your-railway-domain>/auth/callback`. Check it character-by-character.

**`NinjaOne API permission missing` / 403 even after sign-in**
The API app's role doesn't have **Ticketing → Create/Update** granted. Go back to step 1.7 in setup and grant it.

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
- One shared `NinjaClient` (in `src/ninja.ts`) handles both auth flows and request-level errors.
- `UserOAuth` (in `src/user-oauth.ts`) owns the user-context refresh-token lifecycle, including immediate persistence of rotated tokens via atomic file writes.
- Each `/mcp/<slice>` endpoint builds a fresh `McpServer` per request and registers only that slice's tool set. Stateless. No cross-request session bookkeeping.
- Background keepalive refreshes the user-context token every 12 hours so it never goes stale during quiet periods.

```
src/
  index.ts             ← Express app, endpoint routing, boot banners
  config.ts            ← env vars + region → URL derivation + destructive allowlist
  types.ts             ← shared types
  ninja.ts             ← NinjaClient (HTTP + dual auth + cache + audit hook)
  guardrails.ts        ← capability check, confirm-token + dry-run helpers
  user-oauth.ts        ← Authorization Code + Refresh Token lifecycle
  auth-routes.ts       ← /auth/login, /auth/callback, /auth/status
  db.ts                ← Postgres: technicians + audit_log
  domains/
    common.ts          ← DomainContext + jsonResult helper
    status.ts          ← ninja_system_status, _whoami, _auth_status
    lookup.ts          ← ninja_org_find, _find_by_domain, _get, _list_locations, ninja_contact_find
    tickets.ts         ← ticket tools (+ gated delete + add_billable_time)
    customers.ts       ← org create
    devices.ts         ← device tools (+ detail expanders + maintenance + gated delete)
    alerts.ts          ← alert tools (+ gated reset_all)
    billing.ts         ← contracts, invoices, products, ticket products
    vulnerabilities.ts ← CVE-based security triage
    users.ts           ← technician lookup
```

---

## License

MIT
