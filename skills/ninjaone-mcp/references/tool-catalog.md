# NinjaOne MCP — full tool catalog

Every `ninja_*` tool, grouped by domain, with inputs and what it returns. Optional params are
marked `?`. IDs are integers unless noted; the contact "UID" is a string GUID.

## Contents
- [System](#system)
- [Organizations / customers](#organizations--customers)
- [Contacts & users](#contacts--users)
- [Tickets](#tickets)
- [Devices](#devices)
- [Alerts](#alerts)
- [Billing](#billing)
- [Vulnerability scan groups](#vulnerability-scan-groups)

---

## System

| Tool | Input | Returns |
|---|---|---|
| `ninja_system_status` | — | Connectivity check: region, api base URL, OAuth scopes, org count + sample. Use to confirm the MCP can reach NinjaOne. |
| `ninja_system_auth_status` | — | Token / auth state. |
| `ninja_system_whoami` | — | The authenticated identity. |

Scopes note: writes require the `management` scope; `monitoring` alone is read-only.

## Organizations / customers

| Tool | Input | Returns |
|---|---|---|
| `ninja_org_find` | `{ query }` | Fuzzy name search → matching orgs (id + name). Start here when given a client name. |
| `ninja_org_find_by_domain` | `{ domain }` | Resolve an org from `acme.com` or `user@acme.com`. |
| `ninja_org_get` | `{ organization_id }` | Full org record. |
| `ninja_org_list_locations` | `{ organization_id }` | Locations under the org. |
| `ninja_org_create` | org fields | Creates a customer org. Write. |

## Contacts & users

| Tool | Input | Returns |
|---|---|---|
| `ninja_contact_find` | `{ query }` | Contacts by name/email → includes the **UID** used as a ticket requester. |
| `ninja_user_find` | `{ query }` | Technician lookup by name/email → `appUserId` for assignment. |
| `ninja_user_list` | `{ user_type? }` | All users; `user_type` = `TECHNICIAN` or `END_USER`. |

## Tickets

| Tool | Input | Returns / notes |
|---|---|---|
| `ninja_ticket_create` | `{ organization_id` or `organization_domain, subject/summary, description?, requester_uid?, assignee?, ... }` | Creates a ticket. Needs the client org and ideally a requester UID (`ninja_contact_find`). |
| `ninja_ticket_get` | `{ ticket_id }` | The ticket. |
| `ninja_ticket_update` | `{ ticket_id, subject?, status?, priority?, severity?, type?, assignee?, tags?, attributes?, comment_body? }` | Partial update. For closing a ticket use `_resolve`, not `status: CLOSED`. |
| `ninja_ticket_resolve` | `{ ticket_id, comment? }` | Sets status RESOLVED (the correct "done" state). |
| `ninja_ticket_add_comment` | `{ ticket_id, body, public?(default true), time_tracked?(seconds) }` | Public reply or internal note. `time_tracked` is in **seconds** and creates a billable time entry. |
| `ninja_ticket_add_billable_time` | `{ ticket_id, hours?` or `minutes?, description?, public?(default false) }` | Logs billable labor as a NinjaOne time entry (Billable, ticket agreement, labor rate — all server-side). Provide hours **or** minutes. Private note by default. |
| `ninja_ticket_get_log` | `{ ticket_id }` | Full comment + activity history, including `ticketTimeEntry` objects for logged time. |
| `ninja_ticket_list_for_board` | `{ board_id }` | Tickets on a board. |
| `ninja_ticket_list_forms` | — | Ticket forms. |
| `ninja_ticket_list_boards` | — | Boards. |
| `ninja_ticket_list_statuses` | — | Valid status values. |
| `ninja_ticket_list_attributes` | — | Custom attribute definitions. |

## Devices

| Tool | Input | Returns / notes |
|---|---|---|
| `ninja_device_list` | `{ organization_id?, page_size?, device_filter? }` | Devices, optionally scoped to an org. `device_filter` is a raw NinjaOne `df=` filter (power users). |
| `ninja_device_get` | `{ device_id }` | Device record (systemName, displayName, organizationId, …). |
| `ninja_device_list_activities` | `{ device_id, page_size? }` | Recent activity log. |
| `ninja_device_list_software` | `{ device_id }` | Installed software. |
| `ninja_device_list_os_patches` | `{ device_id }` | OS patch state. |
| `ninja_device_list_disks` | `{ device_id }` | Physical disks. |
| `ninja_device_list_volumes` | `{ device_id }` | Volumes. |
| `ninja_device_list_processors` | `{ device_id }` | CPU(s). |
| `ninja_device_list_services` | `{ device_id }` | Windows services. |
| `ninja_device_last_logged_on_user` | `{ device_id }` | Most recent interactive login. |
| `ninja_device_reboot` | `{ device_id, mode }` | `mode` = `NORMAL` or `FORCED`. Write. |
| `ninja_device_set_maintenance` | `{ device_id, end_unix_ms, start_unix_ms?, disabled_features }` | Suppress alerts during a window. `start` defaults to now. |
| `ninja_device_clear_maintenance` | `{ device_id }` | Remove an active maintenance window. |
| `ninja_device_decommission` | `{ device_id, confirm:"DECOMMISSION", dry_run? }` | **Gated** by `NINJA_ALLOW_DESTRUCTIVE=device_delete`. The user must type `DECOMMISSION`. Run `dry_run: true` first. There is no managed-device hard-delete — this is the equivalent. |

## Alerts

| Tool | Input | Returns / notes |
|---|---|---|
| `ninja_alert_list` | `{ device_id?, source_type? }` | Active alerts; filter by device or source type. (Source type is sent as a query param — valid values are NinjaOne source codes; an invalid one returns a 400, not 404.) |
| `ninja_alert_summary` | `{ device_id? }` | Counts grouped by severity — quick NOC view. |
| `ninja_alert_reset` | `{ alert_uid }` | Acknowledge/dismiss one alert. There is no bulk reset endpoint. |

## Billing

| Tool | Input | Returns / notes |
|---|---|---|
| `ninja_billing_list_agreements` | `{ organization_id? }` | Contracts. May be empty if the tenant has none configured. |
| `ninja_billing_get_agreement` | `{ agreement_id }` | One agreement + line items. |
| `ninja_billing_list_invoices` | `{ organization_id?, status? }` | Invoices; `status` e.g. DRAFT/SENT/PAID. |
| `ninja_billing_get_invoice` | `{ invoice_id }` | One invoice + line items. |
| `ninja_billing_list_products` | — | Catalog products. May be empty if none are defined. |
| `ninja_billing_list_accounts` | — | Billing accounts (Hardware, Software, Labor Billed, Ticket Time Entry, Managed Devices, Custom, …). The `id` is the `account_id` for `add_ticket_product`. |
| `ninja_billing_list_ticket_time` | `{ ticket_id }` | Billable **time entries** logged on a ticket (from the ticket log). Use this to confirm logged labor. |
| `ninja_billing_list_ticket_products` | `{ ticket_id }` | **Product** line items on a ticket (parts/charges — distinct from time). |
| `ninja_billing_add_ticket_product` | `{ ticket_id, account_id, name, description?, quantity, price, cost?, billable?(true), taxable?(false) }` | Adds a free-form (adhoc) billable line item. `account_id` from `_list_accounts`. **Requires the client to have a billing agreement** (`agreement_is_required` otherwise). |

## Vulnerability scan groups

NinjaOne exposes no per-CVE or per-device vulnerability read. It only manages "scan groups" —
batches of third-party scanner results uploaded as CSV.

| Tool | Input | Returns / notes |
|---|---|---|
| `ninja_scangroup_list` | — | All scan groups (name, vendor, status, records processed). |
| `ninja_scangroup_get` | `{ scan_group_id }` | One scan group, incl. its CSV header/mapping config. |
| `ninja_scangroup_upload_csv` | `{ scan_group_id, csv }` | Upload raw CSV results. Columns must match the group's configured device/CVE mapping. Write. |
