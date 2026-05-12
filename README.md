# NinjaOne Ticket MCP Server

Small Railway-hosted MCP server for creating NinjaOne tickets.

## What it does now

Tools exposed over `/mcp`:

- `ninja_find_organizations`
- `ninja_list_ticket_forms`
- `ninja_list_ticket_boards`
- `ninja_create_ticket`

## Railway variables

Set these in Railway:

```env
NINJA_TOKEN_URL=https://beardmangroup.rmmservices.net/oauth/token
NINJA_API_BASE_URL=https://beardmangroup.rmmservices.net/api/v2
NINJA_CLIENT_ID=your_client_id
NINJA_CLIENT_SECRET=your_client_secret
MCP_SHARED_SECRET=a_long_random_secret
DEFAULT_TICKET_FORM_ID=
DEFAULT_BOARD_ID=
```

## Local run

```bash
cp .env.example .env
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## MCP URL

After Railway deploys, your MCP endpoint will be:

```text
https://your-railway-domain.up.railway.app/mcp
```

Use this header:

```text
Authorization: Bearer your_MCP_SHARED_SECRET
```

## Important ticket payload note

NinjaOne ticket fields can vary depending on your ticket form setup. If `ninja_create_ticket` returns a 400 response, check `src/ninja.ts`, specifically `buildTicketPayload()`. That is the one place to adjust the payload after we see exactly what your NinjaOne tenant wants.
