# NinjaOne MCP Server

A Railway-hosted MCP server that gives Claude full access to NinjaOne — tickets, customers, devices, and alerts — via separate per-domain endpoints so Claude only loads the toolset it needs.

**Version:** 0.6.0

## What changed in 0.6.0

- **Per-technician tokens.** Multi-tech teams can now share one MCP deployment with per-tech identity. Each tech gets a personal token they append to the MCP URL (`?token=<their-token>`). The server validates the token against an allowlist (`NINJA_TECHNICIANS`), rejects unknown tokens with 401, and uses the matched email as the auto-assignee + comment signer for that connection.
- **Identity from URL, not headers** — works with Claude.ai's custom-connector UI (which doesn't expose a header field).
- **`ninja_whoami` now reports which identity source resolved** — `url-token`, `config` (TECHNICIAN_EMAIL fallback), or `none`. Great for debugging "wait, why is the wrong tech on this ticket?"
- **Backward compatible**: `MCP_SHARED_SECRET` still works for admin / single-tech setups. If `NINJA_TECHNICIANS` is empty, behavior is identical to 0.5.x.

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

### 5. (Multi-tech only) Configure per-technician tokens

Skip this if you're a one-person shop — the `MCP_SHARED_SECRET` + `TECHNICIAN_EMAIL` from earlier works fine.

For a team where each tech should see their own name on tickets they create:

1. Generate one token per tech (any long random string, e.g. `openssl rand -hex 24`).
2. Set the `NINJA_TECHNICIANS` env var in Railway. Two accepted formats:

   **JSON** (recommended for >2 techs):
   ```json
   [
     {"email":"alice@beardmangroup.com","token":"tok_alice_long_random","name":"Alice"},
     {"email":"bob@beardmangroup.com","token":"tok_bob_long_random","name":"Bob"}
   ]
   ```

   **CSV**:
   ```
   alice@beardmangroup.com:tok_alice_long_random:Alice,bob@beardmangroup.com:tok_bob_long_random:Bob
   ```

3. Redeploy. The boot logs should print: `[ninja-mcp] 2 per-tech token(s) registered: alice@...,bob@...`.
4. Each tech connects to a personal URL — see step 6 below.

The token IS the identity. It's not authenticated cryptographically — it's a bearer token like a personal API key. If a tech leaves, remove their entry from `NINJA_TECHNICIANS` and redeploy.

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
  index.ts          ← Express app, endpoint routing, boot banners
  config.ts         ← env vars + region → URL derivation
  types.ts          ← shared types
  ninja.ts          ← NinjaClient (HTTP + dual auth + cache)
  user-oauth.ts     ← Authorization Code + Refresh Token lifecycle
  auth-routes.ts    ← /auth/login, /auth/callback, /auth/status
  domains/
    common.ts       ← DomainContext + jsonResult helper
    status.ts       ← ninja_status, ninja_whoami, ninja_auth_status
    tickets.ts      ← ticket tools
    customers.ts    ← organization + contact tools
    devices.ts      ← device tools
    alerts.ts       ← alert tools
```

---

## License

MIT
