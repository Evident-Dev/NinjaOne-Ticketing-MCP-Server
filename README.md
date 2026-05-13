# NinjaOne Ticketing MCP Server

An MCP server that lets Claude create and manage NinjaOne support tickets using natural language. Deployed on Railway, connected to Claude Desktop (or any MCP client) in minutes.

**Example prompts once connected:**
- *"Create a ticket for Acme Corp, their email is down"*
- *"Add a note to ticket 1042 saying we're waiting on the vendor"*
- *"Close ticket 1038 and mark it resolved"*
- *"Find the org for someone@clientdomain.com and open a high-priority incident"*

---

## Setup

### Step 1 - Create NinjaOne API credentials

1. Log into NinjaOne and go to **Administration -> Apps -> API**
2. Click **Add** to create a new API application
3. Enable BOTH grant types:
   - **Client Credentials** (for read-only operations)
   - **Authorization Code** (required for writes — see Step 4)
4. Under **Allowed scopes**, enable: `monitoring`, `management`, `offline_access`
5. Under **Redirect URIs**, add: `https://<YOUR_RAILWAY_URL>/auth/callback`
   (You won't know the Railway URL until Step 2 — come back and fill this in then.)
6. Copy the **Client ID** and **Client Secret** - you'll need them in Step 3
7. Note your instance base URL - it's the domain you use to log in, e.g. `https://your-instance.rmmservices.net`

> Why two grant types? NinjaOne refuses ticket writes with a `user_context_required` error when called with a pure machine token. Authorization Code lets the server obtain a user-scoped token via a one-time browser login, after which a long-lived refresh token keeps it renewed automatically.

### Step 2 - Deploy to Railway

1. Fork this repo to your GitHub account
2. Go to [railway.app](https://railway.app) and create a new project
3. Choose **Deploy from GitHub repo** and select your fork
4. Railway detects the `Dockerfile` and builds automatically - no extra config needed
5. Once deployed, copy the public URL (e.g. `https://ninjaone-mcp-production.up.railway.app`) and go back to Step 1.5 to set it as the redirect URI in NinjaOne

### Step 3 - Add a Railway Volume for token storage

Writes require a user-scoped refresh token that needs to survive redeploys. In your Railway project:

1. Open the service **Settings -> Volumes**
2. Click **Add Volume** and mount it at `/data`
3. Save — Railway redeploys with the volume attached

(If you skip this step, set `TOKEN_STORE_PATH=./ninja-token.json` instead — but the token will be wiped on every redeploy and you'll have to re-login.)

### Step 4 - Set environment variables in Railway

In your Railway project, go to **Variables -> Raw Editor**. Paste the block below as-is, then fill in your values and click **Update Variables**:

```env
NINJA_TOKEN_URL=https://<YOUR_INSTANCE>.rmmservices.net/oauth/token
NINJA_API_BASE_URL=https://<YOUR_INSTANCE>.rmmservices.net/api/v2
NINJA_CLIENT_ID=
NINJA_CLIENT_SECRET=
MCP_SHARED_SECRET=
TECHNICIAN_EMAIL=
DEFAULT_TICKET_FORM_ID=
```

| Variable | What to put |
|---|---|
| `NINJA_TOKEN_URL` | Replace `<YOUR_INSTANCE>` with your NinjaOne subdomain |
| `NINJA_API_BASE_URL` | Replace `<YOUR_INSTANCE>` with your NinjaOne subdomain |
| `NINJA_CLIENT_ID` | From Step 1 |
| `NINJA_CLIENT_SECRET` | From Step 1 |
| `MCP_SHARED_SECRET` | Generated secret - see below |
| `TECHNICIAN_EMAIL` | Your NinjaOne login email - see below |
| `DEFAULT_TICKET_FORM_ID` | Leave blank for now (see Step 7) |

Advanced (optional):

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | Derived from `RAILWAY_PUBLIC_DOMAIN` | Override only if you're hosting elsewhere or behind a custom domain |
| `OAUTH_REDIRECT_URI` | `<PUBLIC_BASE_URL>/auth/callback` | Override if your redirect URI doesn't follow the standard pattern |
| `OAUTH_SCOPE` | `monitoring management offline_access` | Override the requested scopes |
| `NINJA_AUTHORIZE_URL` | Derived from `NINJA_TOKEN_URL` (swaps `/token` for `/authorize`) | Set explicitly if your tenant uses a non-standard authorize path |
| `TOKEN_STORE_PATH` | `/data/ninja-token.json` | Where to persist the refresh token. Defaults to the Railway Volume mount. |

#### Generating your `MCP_SHARED_SECRET`

Go to [generate-secret.vercel.app/64](https://generate-secret.vercel.app/64) - it will generate a secure random string for you. Copy it and paste it as the `MCP_SHARED_SECRET` value in Railway.

Alternatively, if you have Node.js installed locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `PORT` is injected automatically by Railway. Do not set it manually.

#### About `TECHNICIAN_EMAIL`

Set this to the email address you use to log into NinjaOne. When configured:
- **Tickets you create are auto-assigned to you** - no need to specify an assignee
- **Comments are signed with your name** - since the NinjaOne API attributes everything to the API application, this appends your name so comments are traceable

This is per-deployment: if multiple people on your team each deploy their own Railway instance, each sets their own email. Use `ninja_whoami` to confirm it's wired up correctly.

After saving variables Railway will redeploy. Once it's green, confirm it's working:

```
GET https://<YOUR_RAILWAY_URL>/health
```

### Step 5 - One-time NinjaOne user login

This step grants the server a user-scoped token so it can create tickets, update them, and add comments. You only do this once per Railway instance (and again only if the refresh token is ever revoked).

Open this URL in any browser:

```
https://<YOUR_RAILWAY_URL>/auth/login?token=<YOUR_MCP_SHARED_SECRET>
```

You'll be redirected to NinjaOne, asked to approve the app, and bounced back to a "Connected to NinjaOne" page. The refresh token is now persisted on the Railway Volume.

To confirm, ask Claude:

> *"Check the NinjaOne auth status"*

The `ninja_auth_status` tool will report `authenticated: true`. If it ever reports `false` later, it returns a `login_url` you can click to reconnect.

### Step 6 - Connect Claude

Pick whichever method matches how you use Claude.

---

#### Option A - Claude.ai (browser, no install required)

1. Go to [claude.ai](https://claude.ai) and open **Settings -> Integrations**
2. Click **Add custom integration**
3. Fill in the form:
   - **Name:** NinjaOne Tickets
   - **Remote MCP server URL:** `https://<YOUR_RAILWAY_URL>/mcp?token=<YOUR_MCP_SHARED_SECRET>`
4. Click **Add** - the NinjaOne tools will be available in any new conversation

> The token is passed as a URL parameter since the Claude.ai connector does not support custom headers. Leave Advanced settings alone - that is for OAuth which this server does not use for the MCP transport itself.

---

#### Option B - Claude Desktop (Mac/Windows app)

Open your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this entry under `mcpServers`:

```json
{
  "mcpServers": {
    "ninjaone": {
      "type": "http",
      "url": "https://<YOUR_RAILWAY_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_SHARED_SECRET>"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the NinjaOne tools appear in the tools list.

---

#### Option C - Claude Code (CLI)

For the terminal crowd. Run this once to register the server globally:

```bash
claude mcp add ninjaone --transport http https://<YOUR_RAILWAY_URL>/mcp --header "Authorization: Bearer <YOUR_MCP_SHARED_SECRET>"
```

The tools will be available in every Claude Code session from that point on. To verify:

```bash
claude mcp list
```

---

### Step 7 - (Optional) Set default form ID

If you always want tickets to use a specific form without having to specify it every time, ask Claude:

> *"List the NinjaOne ticket forms"*

Then go back to Railway **Variables** and set `DEFAULT_TICKET_FORM_ID` to the numeric ID of your preferred form. Railway will redeploy automatically.

---

## Available tools

| Tool | What it does |
|---|---|
| `ninja_auth_status` | Check whether the server has a user-scoped NinjaOne token. Returns a login URL if not. |
| `ninja_whoami` | Show which technician this server is configured as |
| `ninja_find_organizations` | Fuzzy-search organizations by name |
| `ninja_find_org_by_domain` | Resolve a client org from an email domain |
| `ninja_find_contact` | Look up a contact by name or email |
| `ninja_list_ticket_forms` | List available ticket forms |
| `ninja_list_ticket_boards` | List available ticket boards (saved filter views) |
| `ninja_list_tickets_for_board` | List tickets currently on a specific board |
| `ninja_list_ticket_statuses` | List configured ticket statuses |
| `ninja_list_ticket_attributes` | List configured ticket attribute/custom field definitions |
| `ninja_get_ticket` | Fetch a ticket by ID |
| `ninja_get_ticket_log` | Fetch the full activity/comment log for a ticket |
| `ninja_create_ticket` | Create a new ticket (requires user auth — see Step 5) |
| `ninja_update_ticket` | Update fields and/or add a comment (requires user auth) |
| `ninja_add_comment` | Add a public reply or internal note (requires user auth) |

---

## Troubleshooting

**Writes fail with "NinjaOne user authentication required..."**
The refresh token is missing or expired. The error message includes the login URL — open it in a browser and re-approve. Or call `ninja_auth_status` to get the URL.

**Login completes but writes still fail with `user_context_required`**
Check that you enabled the `offline_access` scope on the NinjaOne API app. Without it, no refresh token is issued and the server can't mint user-scoped tokens.

**Refresh token gets wiped on every redeploy**
You skipped Step 3 (Railway Volume). Either provision the volume or accept that you'll need to re-login after each deploy.

**`ninja_find_contact` returns nothing for a known contact**
The contact list is cached for 5 minutes. If you just added the contact in NinjaOne, wait or redeploy.

---

## Local development

```bash
cp .env.example .env
# Edit .env with your values. For local dev:
#   PUBLIC_BASE_URL=http://localhost:3000
#   TOKEN_STORE_PATH=./ninja-token.json
# And add http://localhost:3000/auth/callback to the redirect URIs in NinjaOne.
npm install
npm run dev
```

Confirm it's running:
```bash
curl http://localhost:3000/health
```

Test the NinjaOne connection:
```bash
curl -H "Authorization: Bearer <YOUR_MCP_SHARED_SECRET>" \
     http://localhost:3000/debug/test-ninja
```

Then visit `http://localhost:3000/auth/login?token=<YOUR_MCP_SHARED_SECRET>` once to complete the OAuth handshake.

---

## License

MIT
