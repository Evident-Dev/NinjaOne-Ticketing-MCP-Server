# Skills

Claude skills for working with this MCP server. A skill is a folder of Markdown that gives Claude
the tool catalog, workflows, and gotchas up front, so it picks the right call the first time
instead of rediscovering them each session.

## `ninjaone-mcp`

Operator guide for the NinjaOne Ticketing MCP — tickets, billable time, devices, alerts, billing,
organizations, and vulnerability scan groups. Covers the full `ninja_*` tool catalog plus the
non-obvious rules (billable labor = time entries not products, RESOLVE don't CLOSE, ticket products
need a client agreement).

### Install (Claude Code / Claude Desktop)

Copy the skill folder into your personal skills directory:

```bash
# macOS / Linux
cp -r skills/ninjaone-mcp ~/.claude/skills/

# Windows (PowerShell)
Copy-Item -Recurse skills\ninjaone-mcp $env:USERPROFILE\.claude\skills\
```

Restart Claude (or start a new session). The skill loads automatically when you ask anything
NinjaOne-related; you can also invoke it explicitly with `/ninjaone-mcp`.

You need the NinjaOne MCP server connected for the `ninja_*` tools to be available — the skill tells
Claude *how* to use them, the MCP server *provides* them.
