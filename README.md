# NinjaOne MCP Server

A Railway-hosted MCP server that gives Claude full access to NinjaOne — tickets, customers, devices, alerts, billing, and vulnerabilities — via separate per-domain endpoints so Claude only loads the toolset it needs.

**Version:** 0.9.0 · [What's new ↓](#changelog)

---

## Endpoints

Each endpoint is a separate MCP server. Add only the ones you want in Claude.

Each endpoint also ships the **Core Lookup Pack** (`ninja_system_status`, `ninja_system_whoami`, `ninja_system_auth_status`, `ninja_org_find`, `ninja_org_find_by_domain`, `ninja_org_get`, `ninja_org_list_locations`, `ninja_contact_find`) so any workflow can resolve "the customer the user mentioned by name" without changing endpoints.

| URL | Domain-specific tools added | Cross-domain helpers included | Use for |
|---|---|---|---|
| `/mcp` | Everything | — | Power users, scripted workflows |
| `/mcp/tickets` | Ticket CRUD + comment + resolve + add_billable_time + list forms/boards/statuses/attributes | user lookup, device read | Help-desk techs |
| `/mcp/customers` | Org create + locations | device list, billing read | Account managers, intake |
| `/mcp/devices` | Get, list, reboot, activities, software, os_patches, disks, volumes, processors, services, last_logged_on_user, maintenance, (gated) decommission | alert list | Sysadmins, RMM work |
| `/mcp/alerts` | List, summary, reset | device read | NOC / monitoring |
| `/mcp/billing` | Agreements, invoices, products, accounts, ticket time entries + products | ticket read, user lookup | Finance, account managers |
| `/mcp/security` | Vulnerability scan groups (list / get / upload CSV) | device read | Security triage |

Each slice is self-sufficient — a help-desk tech adding `/mcp/tickets` can also resolve a customer by name, find a device to attach, and pick an assignee, without needing the full `/mcp` surface.

---

## Setup

The order matters: the NinjaOne API app needs to know your Railway public URL for its redirect URI, so we provision Railway first and create the NinjaOne app second.

### Step 1 — Fork the repo

Fork this repository (or push your own copy) to GitHub. Railway will deploy from your fork on every push to `master`.

### Step 2 — Deploy to Railway

1. **Create a new Railway project:** **New Project → Deploy from GitHub** → pick your fork. Railway detects the Dockerfile and builds automatically.
2. **Generate a public domain:** **Settings → Networking → Generate Domain.** Note the URL — e.g. `https://ninja-mcp-production.up.railway.app`. You'll need it in Step 3.
3. **Mount a persistent Volume at `/data`:** **Settings → Volumes → New Volume** → mount path `/data` (100 MB is plenty). Without this, your NinjaOne refresh token gets wiped on every redeploy.
4. **(Optional) Attach Postgres:** **+ New → Database → Postgres.** Required for the multi-tech registry (Step 6) and the audit log (recommended). Railway auto-injects `DATABASE_URL`.
5. **Add the initial environment variables.** Go to **Variables** and add what you can now. `NINJA_CLIENT_ID` and `NINJA_CLIENT_SECRET` come in Step 4 — leave them blank for now, the server will start in a "configuration incomplete" mode until they're filled in.

   | Variable | Required? | Value |
   |---|---|---|
   | `NINJA_REGION` | Recommended | `us`, `eu`, `oc`, `ca`, `us2`, or `fed` — see region table below |
   | `MCP_SHARED_SECRET` | **Yes for production** | Long random string. Used for `/mcp/*` Bearer auth AND as the `?token=` query param on `/auth/login`. Generate with `openssl rand -hex 32`. |
   | `TECHNICIAN_EMAIL` | Optional | Your NinjaOne login email — comments are signed with your display name and tickets default to you as assignee |
   | `DEFAULT_TICKET_FORM_ID` | Optional | Numeric ID of your default ticket form. Find it via `ninja_ticket_list_forms` after sign-in. |
   | `PUBLIC_BASE_URL` | Auto | Railway sets `RAILWAY_PUBLIC_DOMAIN` automatically once a domain is generated — we derive the base URL from it. Only set this manually if you need to override. |
   | `USER_TOKEN_PATH` | Default `/data/refresh-token.json` | Path inside the container where the refresh token is persisted. Must be inside a mounted volume. |
   | `NINJA_BASE_URL` | Only for whitelabel | Full base URL if not using a stock region |
   | `NINJA_ALLOW_DESTRUCTIVE` | Optional | CSV of destructive-tool capability keys to enable. Empty = no destructive tools. Recommended: `ticket_delete,alert_reset_all`. Add `device_delete` only if you really need it. |

   **Region table** — pick the one matching the host you log into:

   | Region code | Web URL | Use if you log in at… |
   |---|---|---|
   | `us` | https://app.ninjarmm.com | …app.ninjarmm.com (most US accounts) |
   | `eu` | https://eu.ninjarmm.com | …eu.ninjarmm.com |
   | `oc` | https://oc.ninjarmm.com | …oc.ninjarmm.com (Oceania/APAC) |
   | `ca` | https://ca.ninjarmm.com | …ca.ninjarmm.com (Canada) |
   | `us2` | https://us2.ninjarmm.com | …us2.ninjarmm.com |
   | `fed` | https://app.ninjaone.us | NinjaOne Federal |

   On a partner / whitelabel instance with its own hostname (e.g. `something.rmmservices.net`)? Skip `NINJA_REGION` and set `NINJA_BASE_URL` to your full hostname.

6. **Visit `https://<your-domain>/health`.** You should see `{ ok: true, configured: false, missing: ["NINJA_CLIENT_ID", "NINJA_CLIENT_SECRET"] }` — that's expected at this stage. We'll fix it in Step 4.

### Step 3 — Create the NinjaOne API app

Now that you have your Railway domain, create the API app in NinjaOne:

1. In the NinjaOne admin console: **Administration → Apps → API → Client app IDs → + Add client app**.

   > **Important:** Pick the **Web application** platform (NOT "API Services / machine-to-machine"). The Web platform is the only one that exposes the `offline_access` scope, which NinjaOne requires to issue refresh tokens for the one-time sign-in flow.

2. Fill it in:
   - **Application Platform:** `Web`
   - **Name:** anything (e.g. `Beardman MCP Server`)
   - **Redirect URIs:** `https://<your-railway-domain>/auth/callback` — paste in the domain from Step 2.2. Must match exactly, character by character.
   - **Scopes:** check **Monitoring**, **Management**, and **offline_access**. (Control is optional.)
   - **Allowed Grant Types:** check **Authorization Code**, **Client Credentials**, and **Refresh Token** — all three.
     - *Authorization Code* — for the one-time browser sign-in
     - *Client Credentials* — for fast machine-token reads (orgs, devices, etc.)
     - *Refresh Token* — keeps the sign-in alive indefinitely

3. Click **Add**. You'll be shown the **Client ID** and **Client Secret** — copy both somewhere safe. **The secret is shown once.**

4. **Grant API permissions on the app's role** (this is separate from OAuth scopes and is what actually controls what the app can do):
   - In the app, or under **Administration → Apps → API → Roles**, find the role this app uses and grant at minimum:
     - **Ticketing:** Create, Read, Update (and Delete if you want to enable `ticket_delete`)
     - **Devices:** Read (and Manage if you want reboots, maintenance windows, or `device_delete`)
     - **Organizations:** Read (and Manage if you want to create new orgs from Claude)
     - **Alerts:** Read (and Manage if you want alert reset)
     - **Billing:** Read (billing tools are read-only; logging billable time uses Ticketing Manage)
   - Save. Permissions changes are usually immediate but can take a minute to propagate.

   > **If ticket creation later returns `403` with `resultCode: user_context_required`, it's almost always a permissions issue here.** The OAuth scope (`management`) authorizes the token; the API permission on the app role authorizes the action.

### Step 4 — Add the credentials back to Railway

1. In Railway → your project → **Variables**, set:

   | Variable | Value |
   |---|---|
   | `NINJA_CLIENT_ID` | Client ID from Step 3 |
   | `NINJA_CLIENT_SECRET` | Client Secret from Step 3 |

2. Railway redeploys automatically.
3. Visit `https://<your-domain>/health` again — should now return `{ ok: true, configured: true }`.

### Step 5 — Sign in to NinjaOne (one-time)

The ticket-write endpoints need a user-context OAuth token. You do the browser sign-in once and the server keeps the token refreshed forever.

1. **Open this URL in a browser** (replace `<SECRET>` with your `MCP_SHARED_SECRET`):
   ```
   https://<your-domain>/auth/login?token=<SECRET>
   ```
2. You'll be redirected to NinjaOne's consent screen. Sign in with your normal NinjaOne account and approve.
3. NinjaOne redirects back; you'll see a "Connected to NinjaOne ✓" page.
4. The refresh token is now persisted at `/data/refresh-token.json` and will be auto-renewed forever.

Verify by visiting:
```
https://<your-domain>/auth/status?token=<SECRET>
```
You should see `{ "authenticated": true, "saved_at": "...", ... }`.

**Re-authentication is rare.** The background keepalive refreshes the token every 12 hours, so as long as the server stays up the token never expires. If NinjaOne ever invalidates it (e.g. you revoke API access), the next write will fail with a clear "re-authorize" message and you just revisit `/auth/login`.

### Step 6 — (Multi-tech only) Set up the technician registry

Skip this if you're a one-person shop — `MCP_SHARED_SECRET` + `TECHNICIAN_EMAIL` from Step 2 works fine.

For a team, you have two options:

#### Option A — DB-backed (recommended)

1. If you didn't add Postgres in Step 2.4, do it now: **+ New → Database → Postgres** and attach it to the MCP service. Railway auto-injects `DATABASE_URL`.
2. Redeploy. The boot logs will show:
   ```
   [tech-store] DB schema ready (tables: technicians, audit_log)
   [tech-store] DB mode: 7 technician(s) registered, 7 new
   [tech-store] view the new tokens in Railway → Postgres → Data → technicians
   ```
3. **Open Railway → Postgres service → Data tab → `technicians` table** to see each tech's auto-generated token. Hand them out privately.
4. New techs added in NinjaOne automatically get a row + token within 15 minutes of being added (or instantly the first time they try to use a token).

Bonus: the same Postgres also powers the `audit_log` table — every non-GET request from any technician is recorded with actor, method, path, status, result code, and a payload summary.

#### Option B — Static env-var allowlist (DB-less)

If you don't want a database, set `NINJA_TECHNICIANS` instead. JSON or CSV:

```json
[
  {"email":"alice@beardmangroup.com","token":"tok_alice_xxx","name":"Alice"},
  {"email":"bob@beardmangroup.com","token":"tok_bob_xxx","name":"Bob"}
]
```

Generate tokens with `openssl rand -hex 24`. Updating the team = editing the env var + redeploying. Without `DATABASE_URL`, the audit log is disabled.

The token IS the identity in both modes — it's a personal API key, not cryptographically authenticated. Treat it like a password.

### Step 7 — Connect from Claude

In Claude (Desktop, Web, or Code) add each MCP server endpoint you want. Use the URL plus the shared secret as a Bearer token, or a per-tech URL token.

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

> Add as many or as few endpoints as you want. A help-desk workflow really only needs `tickets` + `customers`. Skipping `devices`, `alerts`, `billing`, and `security` saves Claude from loading their tool schemas, which costs tokens on every turn.

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
| `ninja_ticket_add_billable_time` | Log billable time (hours or minutes) on a ticket as a NinjaOne time entry (billable, billed against the ticket agreement). |
| `ninja_ticket_get_log` | Full comment + activity history. |
| `ninja_ticket_list_for_board` | Tickets on a specific board. |
| `ninja_ticket_list_forms` / `_boards` / `_statuses` / `_attributes` | Discover ticket metadata. |

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
| `ninja_device_decommission` *(gated by `device_delete`)* | Decommission a managed device, with confirm token + dry-run. |

### Alerts

| Tool | Purpose |
|---|---|
| `ninja_alert_list` | All active alerts; optional `device_id` or `source_type`. |
| `ninja_alert_summary` | Count grouped by severity. |
| `ninja_alert_reset` | Dismiss a single alert by UID. |

### Billing

| Tool | Purpose |
|---|---|
| `ninja_billing_list_agreements` / `get_agreement` | Contracts. |
| `ninja_billing_list_invoices` / `get_invoice` | Invoices. |
| `ninja_billing_list_products` | Product catalogue. |
| `ninja_billing_list_accounts` | Billing accounts (needed as `account_id` when adding a ticket product). |
| `ninja_billing_list_ticket_time` | Billable time entries logged on a ticket. |
| `ninja_billing_list_ticket_products` | Product line items attached to a ticket. |
| `ninja_billing_add_ticket_product` | Add a free-form billable line item (part/charge) to a ticket. |

### Security / Vulnerabilities

| Tool | Purpose |
|---|---|
| `ninja_scangroup_list` | List vulnerability scan groups (uploaded scanner-result batches). |
| `ninja_scangroup_get` | Get a scan group by ID. |
| `ninja_scangroup_upload_csv` | Upload a CSV of scanner results to a scan group. |

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
The API app's role doesn't have **Ticketing → Create/Update** granted. Go back to Step 3.4 and grant it.

**Ticket create returns `400` with a field complaint**
Errors are surfaced properly — the response body tells you which field NinjaOne is unhappy with. Common ones:
- `priority` must be one of `NONE | LOW | MEDIUM | HIGH`
- `severity` must be one of `NONE | MINOR | MODERATE | MAJOR | CRITICAL`
- `status` must be a known status name or numeric ID (use `ninja_ticket_list_statuses`)
- Custom attributes must use the attribute IDs from `ninja_ticket_list_attributes`

**Reads work but writes don't, even with permissions**
Double-check that your API app's allowed scopes include `management` (not just `monitoring`). `monitoring` is read-only.

**`Multiple organizations matched 'Acme'`**
The org name is ambiguous. Use `ninja_org_find` to see options and call `ninja_ticket_create` with the explicit `organization_id`.

**A destructive tool (e.g. `ninja_device_decommission`) isn't appearing in Claude**
By design — destructive tools are only registered when their capability key is in `NINJA_ALLOW_DESTRUCTIVE`. Add the key (e.g. `device_delete`) to the env var and redeploy. Check `/health` — it echoes `destructive_allowlist` so you can confirm it took effect.

**Whitelabel / partner instance**
If your NinjaOne hostname isn't on the regional list, leave `NINJA_REGION` unset and set `NINJA_BASE_URL` (e.g. `https://something.rmmservices.net`) — token and API URLs are derived from it.

---

## Architecture

- One Node process serves all endpoints.
- One shared `NinjaClient` (in `src/ninja.ts`) handles both auth flows and request-level errors.
- `UserOAuth` (in `src/user-oauth.ts`) owns the user-context refresh-token lifecycle, including immediate persistence of rotated tokens via atomic file writes.
- Each `/mcp/<slice>` endpoint builds a fresh `McpServer` per request and registers only that slice's tool set. Stateless. No cross-request session bookkeeping.
- Background keepalive refreshes the user-context token every 12 hours so it never goes stale during quiet periods.
- Destructive tools are conditionally registered based on `NINJA_ALLOW_DESTRUCTIVE`. Every non-GET request goes through an audit hook that writes to the Postgres `audit_log` table.

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
    billing.ts         ← contracts, invoices, products, ticket time entries
    vulnerabilities.ts ← CVE-based security triage
    users.ts           ← technician lookup
```

---

## Changelog

### 0.9.1

Audit of every endpoint against the tenant's own OpenAPI spec, correcting paths that 404'd:

- **Billable time.** `ninja_ticket_add_billable_time` now logs a NinjaOne *time entry* on a ticket comment (`timeTracked`, seconds), billed `BILLABLE` against the ticket's agreement automatically — the "Edit time → Use ticket agreement" workflow. (It previously POSTed to a non-existent endpoint.)
- **Ticket products.** Corrected paths: list is `GET /billing/ticket-products/ticket/{id}` (`ninja_billing_list_ticket_products`), create is `POST /billing/ticket-products/adhoc` (`ninja_billing_add_ticket_product`, free-form line items — requires `account_id` from the new `ninja_billing_list_accounts`). Added `ninja_billing_list_ticket_time` to read logged time from the ticket log.
- **Billing path fixes.** `get_agreement` → `/billing/agreements/{id}`, `get_invoice` → `/billing/invoices/{id}`, and `list_customer_accounts` → `ninja_billing_list_accounts` (`/billing/accounts`). All three were calling singular/renamed routes that 404'd.
- **Alerts.** Source-type filter now uses `/alerts?sourceType=` (was a path segment that 404'd). Removed `ninja_alert_reset_all` — the API has no bulk-reset endpoint.
- **Vulnerabilities.** The API exposes no per-CVE/per-device vuln reads, only scan groups. Replaced `ninja_vuln_*` with `ninja_scangroup_list` / `_get` / `_upload_csv`.
- **Device removal.** Replaced `ninja_device_delete` with `ninja_device_decommission` (`POST /device/{id}/decommission`) — the API has no managed-device hard-delete. Removed `ninja_ticket_delete` (no such endpoint).
- **Numeric args coerce.** MCP clients serialize numeric tool arguments as strings; switched every numeric input to `z.coerce.number()`.

### 0.9.0

- **Two new endpoints.** `/mcp/billing` (contracts, invoices, products, ticket-products) and `/mcp/security` (vulnerability triage).
- **Billing domain.** Read contracts/invoices/products/customer-accounts, list ticket-products, and add billable time/products to a ticket — closes the time-tracking → invoice loop. New convenience tool `ninja_ticket_add_billable_time` for hours/minutes-based billing from the tickets endpoint.
- **Vulnerability triage.** `ninja_vuln_list` (with org/severity filter), `ninja_vuln_get` by CVE, `ninja_vuln_list_for_device`.
- **Device detail expanders.** `software`, `os_patches`, `disks`, `volumes`, `processors`, `services`, `last_logged_on_user` — everything you need to diagnose a machine from chat.
- **Maintenance windows.** `ninja_device_set_maintenance` / `clear_maintenance` to suppress alerts during work.
- **Technician lookup.** `ninja_user_list` and `ninja_user_find` so Claude can resolve "assign to <person>" → appUserId.
- **Cross-domain helpers per endpoint.** `/mcp/tickets` now includes user + device lookup. `/mcp/customers` includes devices + billing. Each slice is self-sufficient.
- **Destructive-op guardrails.** Four-layer framework:
  - **Allowlist (`NINJA_ALLOW_DESTRUCTIVE`).** Destructive tools whose capability key isn't in this CSV are not registered — Claude literally can't see them.
  - **Confirm token.** `ninja_device_decommission` requires the user to type `DECOMMISSION` themselves.
  - **Dry-run.** Every gated tool accepts `dry_run: true` to preview the target + payload without acting.
  - **Audit log.** A new Postgres `audit_log` table records every non-GET request.
- **Better error surfacing.** `NinjaApiError` parses `resultCode` + `errorMessage` from NinjaOne JSON bodies.
- **`/health` reports `destructive_allowlist`** so you can verify the env-var took effect without restarting Claude.

Capability keys for `NINJA_ALLOW_DESTRUCTIVE`: `ticket_delete` (recommended), `alert_reset_all` (recommended), `device_delete` (leave off unless you really need it).

### 0.8.0

- **Tool naming convention.** Every tool renamed to `ninja_<resource>_<action>` for consistency and easier discovery (e.g. `ninja_create_ticket` → `ninja_ticket_create`, `ninja_list_alerts` → `ninja_alert_list`).
- Tool descriptions tightened so Claude picks the right tool faster.

### 0.7.0

- **DB-backed technician registry.** Attach a Railway Postgres to the service and the MCP server takes over: on every boot (and every 15 minutes thereafter, and on any auth-miss) it pulls technicians from NinjaOne `/users`, inserts new ones into a `technicians` table, and auto-generates a personal token for each. No env-var bookkeeping when new techs join.
- **Tokens visible in the Railway DB browser.** Admin opens the `technicians` table and copies tokens to hand out. No secret-printing in logs.
- **Backward compatible** — if `DATABASE_URL` isn't set, the old `NINJA_TECHNICIANS` env-var allowlist still works.

### 0.6.0

- **Per-technician tokens** (URL-based) so multi-tech teams can share one deployment.
- **Identity from URL, not headers** — works with Claude.ai's custom-connector UI.
- **`ninja_whoami` reports identity source** — `url-token`, `config`, or `none`.

### 0.5.0

- **Auth model fixed for ticket writes.** NinjaOne's ticket-create / comment / update endpoints physically require a user-context OAuth token. v0.4.0's pure machine-token approach could read but never write. v0.5.0 uses a hybrid:
  - **Reads** (orgs, devices, alerts, lookups): machine token, no login needed.
  - **Writes** (ticket create, comment, update, close, reboot): user-context token from a one-time browser login. Refreshed automatically forever.
- **Refresh-token rotation done correctly.** NinjaOne issues a new refresh token on every refresh; the old one dies instantly. v0.5.0 persists the rotated token to disk via atomic write *before* returning the access token to the caller, so a crash mid-flow can't lock you out.
- **Background keepalive.** Every 12 hours the server refreshes the token even if nothing's been calling it, so the refresh chain stays warm during quiet periods.
- **Clear "login required" UX.** When Claude tries to write and there's no user token, the tool returns a structured error including the sign-in URL. New `ninja_auth_status` tool so Claude can self-diagnose.
- **Loud boot banner** if user login is missing. No silent failures.

### 0.4.0 and earlier

- **Split into per-domain MCP endpoints** — `/mcp/tickets`, `/mcp/customers`, `/mcp/devices`, `/mcp/alerts`, plus `/mcp` for everything.
- **Devices and alerts domains** — list/get/reboot/activities, list/summary/reset.
- **Multi-region** — `NINJA_REGION` (us/eu/oc/ca/us2/fed) derives base URLs.
- **NinjaApiError with parsed resultCode/errorMessage** so failures are debuggable.

---

## License

MIT
