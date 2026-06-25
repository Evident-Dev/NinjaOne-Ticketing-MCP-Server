# NinjaOne MCP — workflow recipes

Step-by-step sequences for the tasks that come up most. Each one names the exact tools in order
and the decisions to make along the way. The point is to avoid the "list everything, then figure
out the ID" round-trips.

## Log billable time on a ticket

The single most common action. NinjaOne records labor as a *time entry* attached to a ticket
comment; it auto-applies Billable + the ticket's agreement + the labor rate.

1. If you only have a ticket number, you're done — go straight to the call.
2. `ninja_ticket_add_billable_time { ticket_id, minutes: 45, description: "what you did" }`
   (or `hours: 1.5`). Add `public: true` only if the note should be client-visible; default is a
   private note.
3. Confirm: `ninja_billing_list_ticket_time { ticket_id }` → the entry shows `timeTracked` (seconds)
   and `time_entry.inHours.billing: "BILLABLE"`.

Notes:
- Don't log the same time twice — each call creates a new entry. If asked to "fix" logged time,
  list first and reason about what's already there.
- `price`/`unit_price` is not a parameter here. Rate comes from the agreement, not the tool.
- Lower-level equivalent: `ninja_ticket_add_comment { ticket_id, body, time_tracked: 2700 }` —
  `time_tracked` is **seconds** (2700 = 45 min).

## Create a ticket for a client

1. Resolve the org: `ninja_org_find { query: "Zama" }` (or `ninja_org_find_by_domain` from an email
   domain). If multiple match, surface them and use the explicit `organization_id` — don't guess.
2. Resolve the requester (optional but preferred): `ninja_contact_find { query }` → use the returned
   UID as the requester.
3. (Optional) assignee: `ninja_user_find { query }` → `appUserId`.
4. `ninja_ticket_create { organization_id, subject, description, requester_uid?, assignee? }`.
5. Returned object has the new `ticket_id` for follow-up work.

## Full job: create → work → bill → resolve

1. Create the ticket (above).
2. Do/record the work; add context with `ninja_ticket_add_comment` (public reply or private note).
3. Log labor: `ninja_ticket_add_billable_time`.
4. Add parts/charges if any: see "Add a part or charge" below.
5. Close it out: `ninja_ticket_resolve { ticket_id, comment: "summary for the client" }`.
   Use resolve — never set `status: CLOSED` via update.

## Add a part or charge (ticket product)

This is for hardware/fixed fees, **not** labor.

1. `ninja_billing_list_accounts` → pick the right `account_id` (e.g. Hardware, Software, Custom).
2. `ninja_billing_add_ticket_product { ticket_id, account_id, name: "Replacement SSD", quantity: 1, price: 120, cost?: 80, taxable?: false }`.
3. Confirm: `ninja_billing_list_ticket_products { ticket_id }`.

If it returns `agreement_is_required`, the client has no billing agreement — products can't attach.
Log the charge as a note for now and tell the user the client needs an agreement first. (Time
entries do **not** have this requirement.)

## Diagnose a device from chat

1. Find it: `ninja_device_list { organization_id }` (scope by client) or list and match by name.
2. `ninja_device_get { device_id }` for the overview.
3. Pull only what the question needs — these are separate calls, so don't fetch all of them blindly:
   - disk space → `ninja_device_list_disks` / `_list_volumes`
   - patching → `ninja_device_list_os_patches`
   - "what's installed" → `ninja_device_list_software`
   - a service is down → `ninja_device_list_services`
   - who's on it → `ninja_device_last_logged_on_user`
   - recent events → `ninja_device_list_activities`
4. Current problems: `ninja_alert_list { device_id }`.

## Device maintenance / reboot

- Suppress alerts during planned work:
  `ninja_device_set_maintenance { device_id, end_unix_ms, disabled_features: [...] }`
  (`start_unix_ms` defaults to now). Clear early with `ninja_device_clear_maintenance`.
- Reboot: `ninja_device_reboot { device_id, mode: "NORMAL" }` (or `FORCED`). This is a real reboot —
  confirm with the user first.

## NOC / alert sweep

1. `ninja_alert_summary` → counts by severity across the fleet (add `device_id` to scope).
2. `ninja_alert_list` → drill into the ones that matter (filter by `device_id` or `source_type`).
3. `ninja_alert_reset { alert_uid }` → dismiss individually. There is no bulk reset.

## Billing read-out for a client

1. `ninja_org_find` → `organization_id`.
2. `ninja_billing_list_agreements { organization_id }` and `ninja_billing_list_invoices { organization_id }`.
3. Drill in with `ninja_billing_get_agreement` / `ninja_billing_get_invoice`.

## Vulnerability scan groups

There's no live per-device CVE listing. To work with scanner data:
1. `ninja_scangroup_list` → existing groups and their status.
2. `ninja_scangroup_get { scan_group_id }` → its CSV column mapping (device header, CVE header).
3. `ninja_scangroup_upload_csv { scan_group_id, csv }` → push a results batch matching that mapping.
