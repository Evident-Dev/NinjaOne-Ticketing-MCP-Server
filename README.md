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
| `NINJA_TOKEN_URL` | `https://your-instance.rmmservices.net/oauth/token` |
| `NINJA_API_BASE_URL` | `https://your-instance.rmmservices.net/api/v2` |
| `NINJA_CLIENT_ID` | from Step 1 |
| `NINJA_CLIENT_SECRET` | from Step 1 |
| `MCP_SHARED_SECRET` | a long random string — generate one with `openssl rand -hex 32` |
| `DEFAULT_TICKET_FORM_ID` | leave blank for now (see Step 5) |
| `DEFAULT_BOARD_ID` | leave blank for now (see Step 5) |

> `PORT` is injected automatically by Railway. Do not set it manually.

After saving variables Railway will redeploy. Once it's green, confirm it's working:

```
GET https://your-service.up.railway.app/health
```

### Step 4 — Connect to Claude Desktop

Open your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this entry under `mcpServers`:

```json
{
  "mcpServers": {
    "ninjaone": {
      "type": "http",
      "url": "https://your-service.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your_MCP_SHARED_SECRET"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the NinjaOne tools appear in the tools list.

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
curl -H "Authorization: Bearer your_MCP_SHARED_SECRET" \
     http://localhost:3000/debug/test-ninja
```

---

## License

MIT
