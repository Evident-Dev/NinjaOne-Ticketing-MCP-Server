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

`ninja_billing_add_ticket_product` fails with this when the ticket's client has no billing agreement.
Check with `ninja_billing_list_agreements`; if the client (or the whole tenant) has none, ticket
products can't be attached. When you hit this: record the charge as a note, and tell the user the
client needs a billing agreement set up in NinjaOne first. (Time entries are unaffected — they log
fine without an agreement.)

## Discover tenant specifics with tools, don't assume them

Tenant configuration varies, so read it rather than hardcoding it:

- **Region / connectivity / scopes** → `ninja_system_status`. (Writes need the `management` scope;
  `monitoring` alone is read-only.)
- **Billing accounts** (for `add_ticket_product.account_id`) → `ninja_billing_list_accounts`.
  Typical names are Hardware, Software, Labor Billed, Ticket Time Entry, Managed Devices, Custom —
  but always use the ids the tool returns.
- **Agreements / catalog products** → `ninja_billing_list_agreements`, `ninja_billing_list_products`.
  Some tenants have neither configured. When products and agreements are empty, prefer **time
  entries** (which work without an agreement) and the **adhoc** product path over `product_id`-based
  flows, and expect `agreement_is_required` when adding a product for a client with no agreement.

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

## Reading NinjaOne errors

The MCP server already targets the right tenant URL — you never need it. When a call fails, the
NinjaOne error code tells you what kind of problem it is:

- A **specific** code (e.g. `agreement_not_found`, `invoice_not_found`, `agreement_is_required`)
  means the request reached the right endpoint — the issue is your input (wrong id) or a business
  rule (missing agreement). Act on it.
- A **generic** `{"resultCode":"FAILURE","errorMessage":"HTTP 404 Not Found"}` is unusual from these
  tools and points at a server/path problem rather than your call — surface it instead of retrying
  blindly.

If you're unsure the MCP can reach NinjaOne at all, `ninja_system_status` confirms connectivity,
region, and scopes.

## Numeric arguments

Pass numbers as numbers. MCP transports serialize them as strings, but the server coerces every
numeric field, so you don't need to stringify, pad, or special-case anything.
