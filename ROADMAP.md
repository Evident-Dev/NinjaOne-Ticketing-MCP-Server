# NinjaOne MCP Server — Feature Coverage & Roadmap

Source of truth: **NinjaOne Public API 2.0** (OpenAPI 2.0.9-draft).
Current MCP version: **0.8.0**.
Vision: **full NinjaOne management from Claude, with guardrails on destructive ops.**

---

## 1. Current Coverage by API Group

Legend: ✅ implemented · 🟡 partial · ⬜ not yet · 🚫 intentionally out of scope

### Ticketing — primary domain
| Endpoint | Tool | Status |
|---|---|---|
| `GET /ticketing/ticket-form` | `ninja_ticket_list_forms` | ✅ |
| `GET /ticketing/trigger/board` | `ninja_ticket_list_boards` | ✅ |
| `GET /ticketing/statuses` | `ninja_ticket_list_statuses` | ✅ |
| `GET /ticketing/attributes` | `ninja_ticket_list_attributes` | ✅ |
| `GET /ticketing/ticket/{id}` | `ninja_ticket_get` | ✅ |
| `GET /ticketing/ticket/{id}/log-entry` | `ninja_ticket_get_log` | ✅ |
| `POST /ticketing/trigger/board/{id}/run` | `ninja_ticket_list_for_board` | ✅ |
| `POST /ticketing/ticket` | `ninja_ticket_create` | ✅ |
| `PUT /ticketing/ticket/{id}` | `ninja_ticket_update` | ✅ |
| (convenience) | `ninja_ticket_resolve` | ✅ |
| `POST /ticketing/ticket/{id}/comment` | `ninja_ticket_add_comment` | ✅ |
| `DELETE /ticketing/ticket/{id}` | — | ⬜ guardrail-gated |
| `PUT /ticketing/ticket/{id}/log-entry/{logId}` | — | ⬜ edit/redact comment |
| `DELETE /ticketing/ticket/{id}/log-entry/{logId}` | — | ⬜ guardrail-gated |
| `POST /ticketing/ticket/{id}/attachment` | — | ⬜ Tier 2 |
| `GET /ticketing/saved-search` | — | ⬜ Tier 2 |

### Organizations & Locations
| Endpoint | Tool | Status |
|---|---|---|
| `GET /organizations` (+search) | `ninja_org_find`, `ninja_org_find_by_domain` | ✅ |
| `GET /organization/{id}` | `ninja_org_get` | ✅ |
| `POST /organizations` | `ninja_org_create` | ✅ |
| `GET /organization/{id}/locations` | `ninja_org_list_locations` | ✅ |
| `PATCH /organization/{id}` | — | ⬜ Tier 2 |
| `POST /organization/{id}/locations` | — | ⬜ Tier 2 |
| `PATCH /organization/{id}/location/{lid}` | — | ⬜ Tier 2 |
| `GET /organization/{id}/end-users` | `ninja_contact_find` (indirect) | 🟡 |
| `GET /organization/{id}/devices` | use `ninja_device_list?organization_id=` | ✅ |
| `GET /organization/{id}/custom-fields` | — | ⬜ |
| `PATCH /organization/{id}/custom-fields` | — | ⬜ guardrail |
| `GET /organization/{id}/documents` | — | ⬜ Tier 2 |
| `POST /organization/{id}/documents` | — | ⬜ Tier 2 |

### Devices
| Endpoint | Tool | Status |
|---|---|---|
| `GET /devices` (+filter) | `ninja_device_list` | ✅ |
| `GET /device/{id}` | `ninja_device_get` | ✅ |
| `GET /device/{id}/activities` | `ninja_device_list_activities` | ✅ |
| `POST /device/{id}/reboot/{mode}` | `ninja_device_reboot` | ✅ |
| `GET /device/{id}/alerts` | use `ninja_alert_list?device_id=` | ✅ |
| `GET /device/{id}/last-logged-on-user` | — | ⬜ Tier 2 |
| `GET /device/{id}/disks` | — | ⬜ Tier 2 |
| `GET /device/{id}/processors` | — | ⬜ Tier 2 |
| `GET /device/{id}/volumes` | — | ⬜ Tier 2 |
| `GET /device/{id}/software` | — | ⬜ Tier 2 |
| `GET /device/{id}/os-patches` | — | ⬜ Tier 2 |
| `GET /device/{id}/os-patch-installs` | — | ⬜ Tier 2 |
| `GET /device/{id}/software-patches` | — | ⬜ Tier 2 |
| `GET /device/{id}/custom-fields` | — | ⬜ |
| `PATCH /device/{id}/custom-fields` | — | ⬜ guardrail |
| `POST /device/{id}/maintenance` | — | ⬜ Tier 1 (workflow) |
| `DELETE /device/{id}/maintenance` | — | ⬜ |
| `POST /device/{id}/script/run` | — | ⬜ destructive, guardrail |
| `DELETE /device/{id}` | — | ⬜ guardrail |
| `PUT /device/{id}` (rename/move) | — | ⬜ Tier 2 |

### Alerts
| Endpoint | Tool | Status |
|---|---|---|
| `GET /alerts` | `ninja_alert_list` | ✅ |
| `DELETE /alert/{uid}` (reset) | `ninja_alert_reset` | ✅ |
| (computed) | `ninja_alert_summary` | ✅ |
| `POST /alerts/reset` (bulk) | — | ⬜ guardrail |

### Groups & Queries (reporting)
| Endpoint | Status |
|---|---|
| `GET /groups` | ⬜ Tier 2 |
| `GET /group/{id}/device-ids` | ⬜ Tier 2 |
| `GET /queries/operating-systems` | ⬜ Tier 2 |
| `GET /queries/software` | ⬜ Tier 2 |
| `GET /queries/os-patches` | ⬜ Tier 2 |
| `GET /queries/antivirus-status` | ⬜ Tier 2 |
| `GET /queries/backup-usage` | ⬜ Tier 2 |
| `GET /queries/disks` / `volumes` / `processors` / `network-interfaces` | ⬜ Tier 3 |
| `GET /queries/logged-on-users` | ⬜ Tier 2 |
| `GET /queries/policy-overrides` | ⬜ Tier 3 |
| `GET /queries/raid-controllers` / `raid-drives` | ⬜ Tier 3 |
| `GET /queries/windows-services` | ⬜ Tier 2 |
| `GET /queries/scoped-custom-fields` | ⬜ Tier 2 |
| `GET /queries/custom-fields-detailed` | ⬜ Tier 3 |
| `GET /queries/computer-systems` | ⬜ Tier 3 |

### Management (write)
| Endpoint | Status | Notes |
|---|---|---|
| `POST /device/{id}/script/run` | ⬜ | **Highest-risk write.** Allowlist + dry-run. |
| `POST /device/{id}/windows-service/{name}/control` | ⬜ Tier 2 | |
| `POST /device/{id}/windows-service/{name}/configure` | ⬜ Tier 2 | |
| `POST /devices/approval/{mode}` | ⬜ | |
| `DELETE /device/{id}` | ⬜ | guardrail |
| `PUT /device/{id}/maintenance` / `DELETE` | ⬜ | |
| `POST /device/{id}/imaging-disable` | ⬜ Tier 3 | |
| `POST /webhook` / `PUT` / `DELETE` | ⬜ Tier 3 | infra-level |

### Billing — **the "contracts" gap**
| Endpoint | Status | Notes |
|---|---|---|
| `GET /billing/agreements` | ⬜ **Tier 1** | "contracts" list |
| `GET /billing/agreement/{id}` | ⬜ **Tier 1** | |
| `POST /billing/agreement` | ⬜ Tier 2 | guardrail (creates billable contract) |
| `PUT /billing/agreement/{id}` | ⬜ Tier 2 | guardrail |
| `DELETE /billing/agreement/{id}` | ⬜ | guardrail |
| `GET /billing/invoices` | ⬜ Tier 1 | |
| `GET /billing/invoice/{id}` | ⬜ Tier 1 | |
| `GET /billing/products` | ⬜ Tier 2 | |
| `POST /billing/product` | ⬜ Tier 2 | guardrail |
| `GET /billing/customer-accounts` | ⬜ Tier 2 | |
| `GET /billing/ticket-products` | ⬜ Tier 2 | |
| `POST /billing/ticket-product` | ⬜ Tier 2 | bill time on a ticket — workflow win |

### Users (technicians / app users)
| Endpoint | Status |
|---|---|
| `GET /users` | ⬜ Tier 2 (helps with assignee lookup) |
| `GET /user/{id}` | ⬜ Tier 2 |

### Backup
| Endpoint | Status |
|---|---|
| `GET /backup/jobs` | ⬜ Tier 2 |
| `GET /backup/usage` | ⬜ Tier 2 |
| `GET /backup/integrity-check-jobs` | ⬜ Tier 3 |

### Knowledge Base
| Endpoint | Status |
|---|---|
| `GET /knowledge-base/articles` | ⬜ Tier 2 |
| `GET /knowledge-base/article/{id}` | ⬜ Tier 2 |

### Document Templates / Org Documents / Checklists
| Endpoint group | Status |
|---|---|
| Document templates (CRUD) | ⬜ Tier 3 |
| Org documents (CRUD) | ⬜ Tier 2 |
| Org checklists (CRUD) | ⬜ Tier 3 |
| Checklist templates | ⬜ Tier 3 |

### Custom Fields, Node Roles, Custom Tabs, Asset Tags/Relationships
| Group | Status |
|---|---|
| Custom field definitions (read) | ⬜ Tier 2 |
| Custom field values write | ⬜ guardrail |
| Node roles | ⬜ Tier 3 |
| Custom tabs | ⬜ Tier 3 |
| Asset tags | ⬜ Tier 3 |
| Asset relationships | ⬜ Tier 3 |

### Vulnerability Management
| Endpoint | Status |
|---|---|
| `GET /vulnerabilities` | ⬜ **Tier 1** — security-team value |
| `GET /vulnerability/{cve}` | ⬜ Tier 1 |
| `GET /device/{id}/vulnerabilities` | ⬜ Tier 1 |

### Unmanaged Devices, Software Licenses
| Group | Status |
|---|---|
| Unmanaged devices read/approve | ⬜ Tier 2 |
| Software licenses read | ⬜ Tier 2 |

### System
| Endpoint | Tool | Status |
|---|---|---|
| `GET /system/info` | `ninja_system_status` | ✅ |
| (OAuth identity) | `ninja_system_whoami`, `ninja_system_auth_status` | ✅ |

---

## 2. Prioritized Roadmap

### Tier 1 — next release (high value, low risk, mostly read)
1. **Billing / contracts read** — `ninja_contract_list`, `ninja_contract_get`, `ninja_invoice_list`, `ninja_invoice_get`. Direct ask from user.
2. **Vulnerability read** — `ninja_vuln_list`, `ninja_vuln_get`, `ninja_device_vulnerabilities`. High Claude-utility for security triage.
3. **Device detail expanders** — software inventory, OS patches, disks/volumes. Powers "diagnose this machine" prompts.
4. **`ninja_ticket_create_with_billing`** — single-shot ticket + billable ticket-product (uses `POST /billing/ticket-product`). Closes the time-tracking → invoice loop.
5. **Better error surfacing** (already on Phase-1 plan): parse `resultCode` / `errorMessage` from NinjaOne 4xx bodies.

### Tier 2 — second release (workflow completers)
- Org/location update + create-location
- Device rename/move, maintenance windows
- Windows service control (start/stop/restart)
- Saved searches + ticket attachments
- KB read
- Users (technician) listing for assignee autocomplete
- Billing agreement/product writes (guardrail-gated)
- Custom field reads
- Backup jobs + usage
- Unmanaged-device approval

### Tier 3 — full management (defer until 1+2 ship)
- Script execution on devices ⚠️ highest risk
- Custom field writes
- Document templates / checklists CRUD
- Webhooks CRUD
- Node roles / custom tabs / asset relationships
- Imaging controls

### Explicitly out of scope
- Test framework (manual verification continues)
- Cloudflare Workers adapter (Railway-only)
- Wyre's `@wyre-technology/node-ninjaone` dep (we own our client)

---

## 3. Destructive-Op Guardrails (design)

Goal: Claude can do anything a tech can, but **dangerous ops are opt-in per deployment** and require explicit user confirmation per call.

### Layer A — env-var capability allowlist
Add to `src/config.ts`:

```ts
NINJA_ALLOW_DESTRUCTIVE = "alert_reset,ticket_delete"   // CSV of capability keys
NINJA_ALLOW_SCRIPT_RUN = false                          // separate flag (highest risk)
NINJA_ALLOW_BILLING_WRITES = false
NINJA_ALLOW_CUSTOM_FIELD_WRITES = false
```

Tools whose capability key is not in the allowlist are **not registered** at server boot — they don't appear in Claude's tool list at all. Cleanest possible guardrail: the model cannot call what it cannot see.

### Layer B — per-call confirmation token
For tools that *are* allowed but still destructive (e.g. `ninja_device_delete`, `ninja_script_run`), require a `confirm` field whose value the user must speak verbatim:

```ts
inputSchema: z.object({
  device_id: z.coerce.number().int().positive(),
  confirm: z.literal("DELETE").describe('Type the word DELETE to confirm — user must say this out loud, not the assistant.')
})
```

Claude is system-prompted ("never auto-fill confirm fields"); the user has to type/say it. This blocks runaway tool loops.

### Layer C — dry-run mode
Every destructive tool accepts `dry_run: z.boolean().default(false)`. When true, the tool resolves the target (e.g. shows *which* ticket would be deleted) and returns the payload it *would* send, without making the call. Lets Claude show the user the diff first.

### Layer D — audit log
Wrap `NinjaClient.request()`: when method is not GET, append a row to `audit_log` (Postgres, already in `src/db.ts`):

```
(ts, session_id, user_email, tool_name, method, path, payload_summary, result_code)
```

Queryable by an `ninja_system_audit` read tool for post-hoc review.

### Layer E — rate ceiling on destructive ops
Token bucket per session: max N destructive calls / hour, configurable. Prevents loop-based mass damage even with all four other layers off.

### Suggested defaults (production)
| Layer | Default |
|---|---|
| Allowlist | empty — destructives off until explicitly enabled |
| Confirm token | required for any DELETE / script-run / bulk-reset |
| Dry-run | offered everywhere, never required |
| Audit log | always on |
| Rate ceiling | 20 destructive ops / session / hour |

---

## 4. Architecture changes implied

- `src/config.ts`: add `destructiveAllowlist: Set<string>`, region helper (already in Phase-4 plan).
- `src/domains/common.ts`: add `requireCapability(key)` helper that returns a no-op registrar when disallowed.
- `src/domains/billing.ts` (new): contracts/invoices/products/ticket-products.
- `src/domains/vulnerabilities.ts` (new): vuln read.
- `src/domains/devices.ts`: expand with software/patches/disks/services + maintenance + (gated) script-run + (gated) delete.
- `src/domains/users.ts` (new): technician listing.
- `src/db.ts`: `audit_log` table + insert helper.
- `src/ninja.ts`: error-body parsing (Phase 1.b), audit hook on non-GET requests.

---

## 5. Sequencing (recommended)

1. **Finish existing Phase 1** — ticket-create fix + better error surfacing (already in plan).
2. **Tier 1, read-only batch** — billing read, vulnerability read, device detail expanders. No guardrails needed; pure value-add.
3. **Guardrail framework** — Layers A–D land together with first destructive tool (`ninja_ticket_delete`) as the canary.
4. **Phase 5 split** — once billing and vuln domains exist, add `/mcp/billing` and `/mcp/security` endpoints to the token-diet menu.
5. **Tier 2** — workflow completers.
6. **Tier 3 + script-run** — last, behind Layer-A flag and a separate `NINJA_ALLOW_SCRIPT_RUN` switch.

---

## 6. Open questions for the user

- Which destructive ops do you actually want from Claude day-1? (e.g. is `ninja_ticket_delete` worth the surface area, or stay read+resolve only?)
- Do you want billing **writes** (create agreement, edit invoice) or only **reads** for now?
- Should `ninja_script_run` ship at all, or stay off forever? (Personal recommendation: stay off — script execution from chat is a foot-cannon even with all five guardrail layers.)
