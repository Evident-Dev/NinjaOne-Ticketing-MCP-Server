---
name: ninjaone-mcp
description: >-
  Operator guide for the NinjaOne Ticketing MCP server (tools prefixed `ninja_*`) — RMM
  tickets, billable time, devices, alerts, billing/invoices/agreements, organizations,
  contacts, technicians, and vulnerability scan groups. Use this whenever the user wants to
  work with NinjaOne in any way: create/update/resolve a ticket, log billable time or hours
  on a ticket, add a charge/line item, look up a client/organization/contact/device, check
  alerts or device health (disks, patches, software, services, volumes, processors, logged-on
  user), reboot or set maintenance on a device, pull invoices/agreements/products, or
  decommission a device — even if they only mention a client name, a ticket number, a device,
  or an MSP task without naming the tool. Picks the correct tool for each job and encodes the
  gotchas that otherwise cost round-trips (billable labor = time entries not products, RESOLVE
  don't CLOSE, ticket products need a client agreement, resolve the org before creating a ticket).
---

# NinjaOne MCP — operator guide

This MCP wraps the NinjaOne (NinjaRMM) public API for a single tenant. Every tool is named
`ninja_<domain>_<action>`. The goal of this skill is to get the right call right the first
time, so you spend tool turns on the task and not on rediscovering paths and rules.

## Orientation (read this first)

- **Always anchor on an ID.** Most actions need an `organization_id`, `device_id`, `ticket_id`,
  or contact UID. If the user gives a name, resolve it first (`ninja_org_find`,
  `ninja_org_find_by_domain`, `ninja_contact_find`, `ninja_device_list`). Don't guess IDs.
- **Numeric args are fine as numbers.** Pass real numbers; the server coerces. No need to
  stringify or special-case.
- **Reads are free; writes are not.** Listing/getting is safe to do liberally to orient.
  Anything that creates, comments, resolves, bills, reboots, or decommissions is a real change
  to the production tenant — confirm intent for irreversible or client-visible actions.

## The five rules that save the most time

1. **Billable labor time = a *time entry*, not a "product".** Use `ninja_ticket_add_billable_time`
   (hours or minutes). NinjaOne logs it on a ticket comment and auto-applies the tenant defaults:
   **Billable**, the **ticket's agreement**, and the tech's labor rate. There is no unit-price to
   pass — the rate comes from the agreement. (`ninja_ticket_add_comment` with `time_tracked` in
   **seconds** does the same at a lower level.)
2. **Ticket *products* are different and need an agreement.** `ninja_billing_add_ticket_product`
   is for parts/fixed charges (a SSD, a flat fee) — not labor. It requires an `account_id`
   (from `ninja_billing_list_accounts`) and the client **must have a billing agreement**, or
   NinjaOne rejects it with `agreement_is_required`.
3. **Resolve, don't close.** `ninja_ticket_resolve` sets status to RESOLVED. NinjaOne treats
   CLOSED as terminal-only; setting it directly via update is the wrong move.
4. **Resolve the org/contact before creating a ticket.** `ninja_ticket_create` needs the client
   org (id or domain) and a requester UID. Look them up first; if a name is ambiguous,
   `ninja_org_find` shows the options — pass the explicit `organization_id`.
5. **Vulnerabilities = scan groups only.** There is no per-CVE or per-device vuln read in the API.
   `ninja_scangroup_*` manages uploaded third-party scanner-result batches. Don't promise live
   per-device CVE data.

## Tool map (what to reach for)

| Need | Tool(s) |
|---|---|
| Confirm the MCP is up / which tenant | `ninja_system_status`, `ninja_system_whoami`, `ninja_system_auth_status` |
| Find a client / its locations | `ninja_org_find`, `ninja_org_find_by_domain`, `ninja_org_get`, `ninja_org_list_locations` |
| Create a client | `ninja_org_create` |
| Find a person (ticket requester UID) | `ninja_contact_find` |
| Find a technician (assignee id) | `ninja_user_find`, `ninja_user_list` |
| Create / read / update / resolve a ticket | `ninja_ticket_create`, `_get`, `_update`, `_resolve` |
| Comment or log time on a ticket | `ninja_ticket_add_comment`, `ninja_ticket_add_billable_time` |
| Ticket history / metadata | `ninja_ticket_get_log`, `ninja_ticket_list_for_board`, `_list_forms`/`_boards`/`_statuses`/`_attributes` |
| List / inspect devices | `ninja_device_list`, `ninja_device_get` |
| Device health & inventory | `ninja_device_list_software`/`_os_patches`/`_disks`/`_volumes`/`_processors`/`_services`, `ninja_device_last_logged_on_user`, `ninja_device_list_activities` |
| Device actions | `ninja_device_reboot`, `ninja_device_set_maintenance`, `ninja_device_clear_maintenance`, `ninja_device_decommission` (gated) |
| Alerts | `ninja_alert_list`, `ninja_alert_summary`, `ninja_alert_reset` |
| Billing reads | `ninja_billing_list_agreements`/`get_agreement`, `_list_invoices`/`get_invoice`, `_list_products`, `_list_accounts` |
| Ticket billing | `ninja_billing_list_ticket_time`, `ninja_billing_list_ticket_products`, `ninja_billing_add_ticket_product` |
| Vulnerability scan groups | `ninja_scangroup_list`, `ninja_scangroup_get`, `ninja_scangroup_upload_csv` |

Full per-tool parameters and return shapes: **[references/tool-catalog.md](references/tool-catalog.md)**.

## Common workflows (the fast paths)

These are the sequences that come up constantly. Full step-by-step versions, including edge
cases and example payloads, are in **[references/workflows.md](references/workflows.md)**.

- **Log time on a job:** `ninja_ticket_add_billable_time { ticket_id, minutes|hours, description }`.
  Defaults to a private note; pass `public: true` to put it on a client-visible reply. Verify with
  `ninja_billing_list_ticket_time { ticket_id }`.
- **Create + work + close a ticket:** find org (`ninja_org_find`) → find requester
  (`ninja_contact_find`) → `ninja_ticket_create` → do work → `ninja_ticket_add_billable_time` →
  `ninja_ticket_resolve { ticket_id, comment }`.
- **Diagnose a machine from chat:** `ninja_device_list { organization_id }` (or by name) →
  `ninja_device_get` → the `_list_*` expanders for disks/patches/software/services as the question
  demands → `ninja_alert_list { device_id }`.
- **Add a part/charge to a ticket:** `ninja_billing_list_accounts` to pick `account_id` →
  `ninja_billing_add_ticket_product { ticket_id, account_id, name, quantity, price }`. Fails with
  `agreement_is_required` if the client has no agreement — see gotchas.
- **NOC sweep:** `ninja_alert_summary` for counts by severity → `ninja_alert_list` to drill in →
  `ninja_alert_reset { alert_uid }` to dismiss individually.

## Gotchas & tenant facts

Before concluding "the API can't do X" or debugging a confusing error, check
**[references/gotchas.md](references/gotchas.md)**. It covers the billing model in depth, the
`agreement_is_required` constraint, the error-code diagnostic (specific code = route OK, generic
`FAILURE`/HTTP 404 = wrong route), destructive-op gating and confirm tokens, current tenant state
(no agreements/products configured yet), units (`time_tracked` is seconds), and how to verify an
endpoint against the live API spec.

## When something 404s or behaves oddly

The authoritative API spec and a live-verification method are documented in gotchas.md. In short:
the tenant's own OpenAPI spec lives at `https://beardmangroup.rmmservices.net/apidocs/NinjaRMM-API-v2.json`,
and you can validate any path by `fetch()`-ing it from that logged-in apidocs page (Claude-in-Chrome).
A *specific* NinjaOne error code means the route is right; a *generic* `HTTP 404 Not Found` means the
path is wrong.
