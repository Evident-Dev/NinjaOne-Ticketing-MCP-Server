# 0.9.0 — Changes & Tomorrow's Test Plan

## TL;DR
- Big surface expansion: billing (contracts/invoices/products), vulnerabilities, device-detail expanders, technician lookup, ticket delete, alert bulk-reset, device maintenance.
- New endpoints: `/mcp/billing`, `/mcp/security`.
- Guardrail framework for destructive ops (allowlist + confirm token + dry-run + Postgres audit log).
- Cross-domain helpers added to each slice so endpoints can actually do their job standalone.
- Existing 0.8.0 surface untouched and re-verified end-to-end against Beardman Cafe (ticket #1007).

---

## Tonight's verification (already done against deployed 0.8.0)

| Step | Result |
|---|---|
| `ninja_system_status` | ✓ region us2, 25 orgs |
| `ninja_system_auth_status` | ✓ user-token active |
| `ninja_system_whoami` | ✓ Andrew Dillon (source: url-token) |
| `ninja_org_find` "Beardman Cafe" | ✓ id 25 |
| `ninja_org_get`, `ninja_org_list_locations` | ✓ Main Office (loc 27) |
| `ninja_device_list` org 25 | ✓ (0 devices — test org) |
| `ninja_ticket_list_{forms,boards,statuses,attributes}` | ✓ all populated |
| `ninja_ticket_create` against org 25 | ✓ **ticket #1007** |
| `ninja_ticket_add_comment` public | ✓ signed "— Andrew Dillon" |
| `ninja_ticket_add_comment` internal w/ time_tracked=900 | ✓ logged as 900s BILLABLE in-hours |
| `ninja_ticket_update` status WAITING + priority MEDIUM | ✓ version 1→3 |
| `ninja_ticket_get_log` | ✓ 5 entries: DESCRIPTION, SAVE (create), COMMENT×2, SAVE (update) |
| `ninja_ticket_resolve` | ✓ version 5, status RESOLVED |
| `ninja_alert_list` / `ninja_alert_summary` | ✓ 6 active alerts |
| `ninja_device_get` (id 1) | ✓ full inventory returned |
| `ninja_device_list_activities` (id 1) | ✓ 10 entries (conditions + software updates) |

**One small finding:** `ninja_ticket_create` rejects `tags` when the MCP transport serializes it as a JSON-encoded string. Worked fine when passed as a proper array. Worth keeping an eye on — could affect some Claude client builds. Not a code change for 0.9.0.

---

## What's new in 0.9.0

### New endpoints
| URL | Slice contents (in addition to status + lookup core) |
|---|---|
| `/mcp/billing` | billing tools + tickets + users — finance/AM workflow |
| `/mcp/security` | vulnerabilities + devices — security triage |

Existing endpoints reorganized to include cross-domain helpers so each slice is self-sufficient:

| URL | Adds to slice |
|---|---|
| `/mcp/tickets` | + `ninja_user_*` (assignee lookup), + `ninja_device_*` (attach to ticket) |
| `/mcp/customers` | + `ninja_device_*` (what they own), + `ninja_billing_*` (their contracts) |
| `/mcp/devices` | + `ninja_alert_*` (what's wrong with it) |
| `/mcp/alerts` | + `ninja_device_*` (which device fired) |

### New tools
**Billing** (`ninja_billing_*`):
- `list_agreements`, `get_agreement`
- `list_invoices`, `get_invoice`
- `list_products`, `list_customer_accounts`
- `list_ticket_products`
- `add_ticket_product` *(write — attaches billable time/charge to a ticket)*

**Vulnerabilities** (`ninja_vuln_*`):
- `list` (optional org/severity filter)
- `get` (by CVE)
- `list_for_device`

**Users** (`ninja_user_*`):
- `list` (technicians by default, opt-in for end users)
- `find` (search by name/email — returns appUserId for assignment)

**Device detail expanders** (`ninja_device_list_*`):
- `software`, `os_patches`, `disks`, `volumes`, `processors`, `services`
- `last_logged_on_user`
- `set_maintenance`, `clear_maintenance`

**Tickets**:
- `add_billable_time` (hours/minutes → ticket-product, convenience wrapper)

**Destructive (gated — see below)**:
- `ninja_ticket_delete`
- `ninja_device_delete`
- `ninja_alert_reset_all` (by source type)

### Guardrails (Layers A–D)
| Layer | How |
|---|---|
| **A. Allowlist** | `NINJA_ALLOW_DESTRUCTIVE` env var, CSV of capability keys. Not in the list → not registered → invisible to Claude. |
| **B. Confirm token** | Destructive tools require `confirm: "DELETE"` or `"RESET"` — the user must say the word. |
| **C. Dry-run** | `dry_run: true` returns target + would-send payload without executing. |
| **D. Audit log** | New Postgres table `audit_log` records every non-GET request (actor, method, path, status, result_code, payload summary, error). |

Layer E (rate ceiling) deferred to 0.9.1.

### Other improvements
- `NinjaApiError` now exposes `resultCode`/`errorMessage` parsed from the NinjaOne JSON body (was already partially there — confirmed working).
- Audit hook on `NinjaClient.request()` and `requestMultipart()` — best-effort, never throws.
- `/health` now reports `destructive_allowlist` so you can verify env in Railway.
- `db.ts` bootstrap creates both `technicians` and `audit_log` tables.

---

## Things needing YOUR eyes tomorrow

### 1. Deploy to Railway
The Railway MCP returned `Unauthorized` — you'll need to `railway login` (or whatever your auth flow is) before I can deploy from here. Once you're logged in, either:
- I push the build and we run the test plan together, OR
- You merge develop → master, Railway auto-deploys, and we test.

### 2. Set env vars in Railway (before testing destructive ops)
- `NINJA_ALLOW_DESTRUCTIVE` — **leave empty** for first deploy. Sanity check that nothing dangerous shows up. Then set to e.g. `ticket_delete,alert_reset_all` to test those flows. Don't enable `device_delete` until we've thought about it.
- Nothing else changed env-wise.

### 3. Test plan for the new tools (after deploy)

Walk these together in Claude tomorrow:

**Billing** (use `/mcp/billing`)
- `ninja_billing_list_agreements organization_id=25` — what contracts does Beardman Cafe have
- `ninja_billing_list_invoices organization_id=25` — same for invoices
- `ninja_billing_list_products` — see if your labor products surface
- **End-to-end billable time**: create a fresh test ticket → `ninja_ticket_add_billable_time ticket_id=<new> product_id=<labor> hours=0.5` → `ninja_billing_list_ticket_products ticket_id=<new>` → verify it shows up

**Vulnerabilities** (use `/mcp/security`)
- `ninja_vuln_list page_size=10` — does it return anything for the tenant
- `ninja_vuln_list_for_device device_id=1` — your own desktop

**Device detail** (use `/mcp/devices`)
- Pick a real device (id 1 = your EVIDENT_DESKTOP; alerts also referenced ids 9, 13, 19)
- `ninja_device_list_software device_id=1` — should list every installed program
- `ninja_device_list_os_patches device_id=1`
- `ninja_device_list_disks device_id=1`, `_volumes`, `_processors`, `_services`
- `ninja_device_last_logged_on_user device_id=1`
- **Maintenance round-trip**: `set_maintenance device_id=<some test device> end_unix_ms=<now + 5min>` → confirm in NinjaOne UI alerts are suppressed → `clear_maintenance`

**Users** (use `/mcp/tickets` or `/mcp/billing`)
- `ninja_user_list` — should return technicians
- `ninja_user_find query="andrew"` — should return your appUserId (which is 1)

**Guardrails** (set `NINJA_ALLOW_DESTRUCTIVE=ticket_delete` first)
- Confirm `ninja_ticket_delete` now appears in Claude's tool list (it shouldn't if the var is empty)
- Create a throwaway ticket against Beardman Cafe
- `ninja_ticket_delete ticket_id=<throwaway> dry_run=true confirm="DELETE"` → should return preview only, ticket still exists
- `ninja_ticket_delete ticket_id=<throwaway> confirm="DELETE"` → ticket gone
- Try once without `confirm` → should be rejected by zod

**Audit log**
- After running any of the above writes, query the `audit_log` table in Railway → Postgres → Data:
  ```sql
  SELECT id, ts, actor_email, method, path, status_code, result_code
  FROM audit_log ORDER BY id DESC LIMIT 20;
  ```
- Every non-GET should have a row. GETs should not.

### 4. Open questions to decide
- **`device_delete`**: do you want it available at all, even gated? I left it off your allowlist suggestion above. The undo-cost is high.
- **Billing writes beyond `add_ticket_product`** (create agreement, edit invoice): worth doing in 0.9.1 or skip?
- **Script execution** (`ninja_script_run`): still recommending we never ship this. Confirm?

---

## File changes summary

**New:**
- `src/guardrails.ts`
- `src/domains/billing.ts`
- `src/domains/vulnerabilities.ts`
- `src/domains/users.ts`

**Modified:**
- `package.json` — 0.8.0 → 0.9.0
- `src/config.ts` — adds `destructiveAllowlist` + `NINJA_ALLOW_DESTRUCTIVE` parsing
- `src/db.ts` — `audit_log` table + `writeAudit` + `recentAudit`
- `src/ninja.ts` — adds methods for billing/vuln/device-detail/users/maintenance/delete + audit hook; `setAuditDb` constructor wiring
- `src/domains/devices.ts` — adds detail expanders + maintenance + gated delete
- `src/domains/tickets.ts` — adds `add_billable_time` + gated delete
- `src/domains/alerts.ts` — adds gated `reset_all`
- `src/index.ts` — adds billing/security/users domains, two new endpoints, cross-domain wiring, audit-DB wiring, guardrail banner

`npm run build` passes cleanly.

---

## Mem note follow-up
The note `b602a0e5-6637-44ea-9a00-31e7df33a2c1` in `#boardman` returned with `content: ""` — only metadata, no body. The OpenAPI JSON you intended to attach didn't land in the note body. Not blocking — I used the full spec from your earlier in-chat paste. Worth re-pasting / re-uploading into that note when you get a chance so future sessions can pull it cleanly.
