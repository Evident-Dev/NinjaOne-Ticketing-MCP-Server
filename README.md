# NinjaOne Ticketing MCP Server

An MCP server that lets Claude create and manage NinjaOne support tickets using natural language. Deployed on Railway, connected to Claude Desktop (or any MCP client) in minutes.

**Example prompts once connected:**
- *"Create a ticket for Acme Corp — their email is down"*
- *"Add a note to ticket 1042 saying we're waiting on the vendor"*
- *"Close ticket 1038 and mark it resolved"*
- *"Find the org for someone@clientdomain.com and open a high-priority incident"*

---

## Setup

### Step 1 — Create NinjaOne API credentials

1. Log into NinjaOne and go to **Administration → Apps → API**
2. Click **Add** to create a new API application
3. Set the grant type to **Client Credentials**
4. Copy the **Client ID** and **Client Secret** — you'll need them in Step 3
5. Note your instance base URL — it's the domain you use to log in, e.g. `https://your-instance.rmmservices.net`

### Step 2 — Deploy to Railway

1. Fork this repo to your GitHub account
2. Go to [railway.app](https://railway.app) and create a new project
3. Choose **Deploy from GitHub repo** and select your fork
4. Railway detects the `Dockerfile` and builds automatically — no extra config needed

### Step 3 — Set environment variables in Railway

In your Railway project, go to **Variables** and add:

| Variable | Value |
|---|---|
| `NINJA_TOKEN_URL` | `https://<YOUR_INSTANCE>.rmmservices.net/oauth/token` |
| `NINJA_API_BASE_URL` | `https://<YOUR_INSTANCE>.rmmservices.net/api/v2` |
| `NINJA_CLIENT_ID` | from Step 1 |
| `NINJA_CLIENT_SECRET` | from Step 1 |
| `MCP_SHARED_SECRET` | a long random string — see below for how to generate one |
| `DEFAULT_TICKET_FORM_ID` | leave blank for now (see Step 5) |
| `DEFAULT_BOARD_ID` | leave blank for now (see Step 5) |
| `TECHNICIAN_EMAIL` | your NinjaOne login email (see below) |

#### Generating your `MCP_SHARED_SECRET`

Run this in your terminal before you deploy — Node.js is already required for this project:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and paste it as the `MCP_SHARED_SECRET` value in Railway. That's it.

> `PORT` is injected automatically by Railway. Do not set it manually.

#### About `TECHNICIAN_EMAIL`

Set this to the email address you use to log into NinjaOne. When configured:
- **Tickets you create are auto-assigned to you** — no need to specify an assignee
- **Comments are signed with your name** — since the NinjaOne API attributes everything to the API application rather than a human, this appends `— Your Name` so comments are traceable

This is per-deployment: if multiple people on your team each deploy their own Railway instance, each sets their own email. Use `ninja_whoami` to confirm it's wired up correctly.

After saving variables Railway will redeploy. Once it's green, confirm it's working:

```
GET https://<YOUR_RAILWAY_URL>/health
```

### Step 4 — Connect Claude

Pick whichever method matches how you use Claude.

---

#### Option A — Claude.ai (browser, no install required)

1. Go to [claude.ai](https://claude.ai) and open **Settings → Integrations**
2. Click **Add custom integration**
3. Fill in the form:
   - **Name:** NinjaOne Tickets
   - **URL:** `https://<YOUR_RAILWAY_URL>/mcp`
   - **Authorization header:** `Bearer <YOUR_MCP_SHARED_SECRET>`
4. Click **Save** — the NinjaOne tools will be available in any new conversation

---

#### Option B — Claude Desktop (Mac/Windows app)

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

#### Option C — Claude Code (CLI)

For the terminal crowd. Run this once to register the server globally:

```bash
claude mcp add ninjaone --transport http https://<YOUR_RAILWAY_URL>/mcp --header "Authorization: Bearer <YOUR_MCP_SHARED_SECRET>"
```

The tools will be available in every Claude Code session from that point on. To verify:

```bash
claude mcp list
```

---

### Step 5 — (Optional) Set default form and board IDs

If you always want tickets to land on a specific board or use a specific form without having to specify it every time, ask Claude:

> *"List the NinjaOne ticket forms"*
> *"List the NinjaOne ticket boards"*

Then go back to Railway **Variables** and set:
- `DEFAULT_TICKET_FORM_ID` — the numeric ID of your preferred form
- `DEFAULT_BOARD_ID` — the numeric ID of your preferred board

Railway will redeploy automatically.

---

## Available tools

| Tool | What it does |
|---|---|
| `ninja_find_organizations` | Fuzzy-search organizations by name |
| `ninja_find_org_by_domain` | Resolve a client org from an email domain |
| `ninja_find_contact` | Look up a contact by name or email |
| `ninja_get_ticket` | Fetch a ticket by ID |
| `ninja_create_ticket` | Create a new ticket |
| `ninja_update_ticket` | Update fields and/or add a comment in one call |
| `ninja_add_comment` | Add a public reply or internal note |
| `ninja_list_ticket_forms` | List available ticket forms |
| `ninja_list_ticket_boards` | List available boards |
| `ninja_list_ticket_statuses` | List configured statuses |
| `ninja_whoami` | Show which technician this server is configured as |

---

## Local development

```bash
cp .env.example .env
# Edit .env with your values
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

---

## License

MIT
