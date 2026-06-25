# NinjaOne MCP — gotchas, tenant facts, and how to verify

The non-obvious things that otherwise cost a round-trip or a wrong conclusion. Most of these were
learned by verifying against the live API, so trust them over first instinct.

## The billing model (the big one)

NinjaOne has **two separate** billable primitives on a ticket, and they behave differently:

1. **Time entries = labor.** Created by logging time on a ticket comment
   (`ninja_ticket_add_billable_time`, or `ninja_ticket_add_comment` with `time_tracked` seconds).
   NinjaOne applies the billing defaults server-side: `billing: BILLABLE`, the **ticket's
   agreement** (`agreementOriginType: TICKET` — the "Use ticket agreement" toggle), and the tech's
   labor rate (e.g. "Remote"). **There is no unit price** — the rate comes from the agreement.
   This works even when the client has no agreement (the entry just shows `agreement: null`,
   `price: 0` until the client is on a contract).
2. **Ticket products = parts/charges.** Created by `ninja_billing_add_ticket_product`
   (free-form/adhoc). These have `quantity` + `price` + an `account_id`, and they **require the
   client to have a billing agreement** — without one, NinjaOne returns `agreement_is_required`.

If a user says "log my time," that's #1. If they say "charge them for the drive I installed,"
that's #2. Don't use a product to record labor.

## `agreement_is_required`

`ninja_billing_add_ticket_product` fails with this when the ticket's client has no agreement. As of
this writing the tenant has **zero agreements configured tenant-wide**, so ticket products can't be
created for anyone yet. When you hit this: record the charge as a note, and tell the user the client
needs a billing agreement set up in NinjaOne first. (Again: time entries are unaffected.)

## Current tenant state (verify if stale — this is point-in-time)

- `ninja_billing_list_agreements` → `[]` (no agreements).
- `ninja_billing_list_products` → `[]` (no catalog products defined). So for billing, prefer the
  free-form/adhoc path and time entries over `product_id`-based flows.
- Region `us2`; scopes `monitoring management offline_access`.
- Billing accounts that exist (for `add_ticket_product.account_id`): Hardware, Software, Labor
  Billed, Ticket Time Entry, Managed Devices, Managed End User, Device Backup, User Product,
  Product Group, Custom.

## Status: RESOLVE, don't CLOSE

`ninja_ticket_resolve` sets RESOLVED. NinjaOne treats CLOSED as a terminal-only state — driving a
ticket to CLOSED via `ninja_ticket_update { status: "CLOSED" }` is the wrong path. Resolved is the
normal "done."

## Units

- `ninja_ticket_add_comment`'s `time_tracked` is in **seconds** (45 min = 2700).
- `ninja_ticket_add_billable_time` takes **hours** or **minutes** (friendlier — prefer it).
- Maintenance windows use **unix milliseconds** (`end_unix_ms`, `start_unix_ms`).

## Destructive operations are gated

Decommission is the only destructive tool normally exposed, and only when the server env
`NINJA_ALLOW_DESTRUCTIVE` includes `device_delete`. It requires the user to type the confirm word
(`DECOMMISSION`) verbatim — never auto-fill it — and supports `dry_run: true` to preview the target
first. There is **no** managed-device hard-delete and **no** ticket delete in the API; "remove a
device" means decommission.

## Things the API simply doesn't do

- **No per-CVE or per-device vulnerability read.** Only scan groups (`ninja_scangroup_*`). Don't
  offer live per-device CVE exposure.
- **No bulk alert reset.** Only single-alert `ninja_alert_reset`.
- **No ticket delete, no managed-device delete.**

## Lookups before writes

`organization_id`, the contact requester UID, and the assignee `appUserId` all come from lookups
(`ninja_org_find` / `_find_by_domain`, `ninja_contact_find`, `ninja_user_find`). When a name is
ambiguous, `ninja_org_find` returns multiple — surface them and use the explicit id rather than
guessing. Domain-based lookup (`ninja_org_find_by_domain`) is the most reliable when you have an
email address.

## Verifying an endpoint against the live API

If a call 404s or you're unsure a path exists, the authoritative spec is the tenant's own:
`https://beardmangroup.rmmservices.net/apidocs/NinjaRMM-API-v2.json` (interactive docs at
`https://beardmangroup.rmmservices.net/apidocs/?links.active=core`).

With the user logged into that site, open it in Claude-in-Chrome and `fetch()` paths from the page
context — the session cookie authorizes calls (paths work with or without the `/api` prefix, e.g.
`/v2/billing/accounts`). The MCP server's own base is `https://us2.ninjarmm.com/api/v2`, so MCP code
paths like `/billing/x` map to spec `/v2/billing/x`.

**The 404 diagnostic:** a NinjaOne 404 with a *specific* `resultCode` (e.g. `agreement_not_found`,
`invoice_not_found`) means the route exists and the entity is just missing. A *generic*
`{"resultCode":"FAILURE","errorMessage":"HTTP 404 Not Found"}` means the route itself is wrong.
This is how the v0.9.1 path corrections were found.

## Numeric arguments

Pass numbers as numbers. MCP transports serialize them as strings, but the server coerces every
numeric field, so you don't need to stringify, pad, or special-case anything.
