# NinjaOne Ticketing MCP Server

An MCP server that lets Claude create and manage NinjaOne support tickets using natural language. Deploy it on Railway and point any MCP-compatible client at it.

## Features

- Create tickets — resolve the client org by name, email domain, or numeric ID
- Update tickets — change status, priority, severity, type, assignee
- Add comments — public replies or internal technician notes
- Look up organizations, contacts, forms, boards, and statuses
- Domain-based org resolution — give Claude an email address and it finds the right client

## Tools exposed over `/mcp`

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

## Deploy to Railway

### 1. Fork / clone this repo

### 2. Create a new Railway project from your GitHub repo

Railway will detect the `Dockerfile` and build automatically.

### 3. Set environment variables in Railway

```
NINJA_TOKEN_URL=https://your-instance.rmmservices.net/oauth/token
NINJA_API_BASE_URL=https://your-instance.rmmservices.net/api/v2
NINJA_CLIENT_ID=your_client_id
NINJA_CLIENT_SECRET=your_client_secret
MCP_SHARED_SECRET=a_long_random_secret
DEFAULT_TICKET_FORM_ID=
DEFAULT_BOARD_ID=
```

> **Tip:** Generate a strong secret with `openssl rand -hex 32`

`PORT` is set automatically by Railway — do not override it.

### 4. Your MCP endpoint

Once deployed:

```
https://your-service.up.railway.app/mcp
```

Configure your MCP client with:
```
Authorization: Bearer <your MCP_SHARED_SECRET>
```

### Health check

```
GET https://your-service.up.railway.app/health
```

## Local development

```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run dev
```

Then hit `http://localhost:3000/health` to confirm it's running.

To test the NinjaOne connection:

```bash
curl -H "Authorization: Bearer your_MCP_SHARED_SECRET" \
     http://localhost:3000/debug/test-ninja
```

## NinjaOne API credentials

1. In NinjaOne go to **Administration → Apps → API**
2. Create a new application with the **Client Credentials** grant type
3. Copy the **Client ID** and **Client Secret** into your environment variables
4. The token URL and API base URL follow the pattern in `.env.example`

## License

MIT
