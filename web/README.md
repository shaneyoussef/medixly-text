# Web

Static pages, deployed to Netlify from this repo.

Two separate Netlify sites point at this one repo, each with its own publish
directory. They are kept apart deliberately: `form/` is meant to be public and
advertised; `queue/` must never be.

| Folder | Audience | Netlify publish directory | Access |
|---|---|---|---|
| `form/` | Patients | `web/form` | Public |
| `queue/` | Pharmacy staff | `web/queue` | Private — Netlify visitor access set to private, plus the staff key |

`form/` holds the secure chat client, served at that site's root from
`index.html`. Five forms work end to end against a stub transport — transfer,
refill, prescription upload, minor ailment assessment and pharmacist callback —
each mapped to an intent `api/submit.ts` accepts. `secure-chat.print.js` is still
a placeholder, so no print or fax sheet can be generated. See
[`HANDOFF.md`](HANDOFF.md).

Patients can also order over-the-counter products in the thread — product cards,
a basket, and Shopify checkout without leaving the page. Only products in a
curated Shopify collection are sellable, and that collection does not exist yet.
See [`../docs/SHOP.md`](../docs/SHOP.md).

An agent routes free-text messages to the right form, product search, or a
pharmacist. It never suggests a product for a symptom. A pharmacist answers
everything it hands over — see [`../docs/AGENT.md`](../docs/AGENT.md).

Two things must change before a real patient: the consent block needs the privacy
officer's sign-off, and the minor ailment assessment's red-flag questions have to
come from the pharmacy's clinical protocol. Both are flagged in `HANDOFF.md`.

Never set a publish directory to `web/` itself. That would serve `queue/` from
the public site.

Both call the Supabase edge functions in `ca-central-1`. No patient data is
stored by Netlify; it serves HTML only.

## Netlify setup

For each site: Add new site → Import an existing project → this repo.

- Build command: leave empty (no build step)
- Publish directory: `web/form` or `web/queue`

Pushing to `main` redeploys both.

## Before real patients

- Replace the shared staff key with per-person authentication.
- Rate limits on `chat` are in-memory per isolate; add an edge-wide store before a leaked token is a realistic threat. `submit` and `shop` are still unthrottled.
- Pharmacist sign-off on the `chat-eligible` collection: some of what a pharmacy
  stocks cannot lawfully be sold from an unattended cart.
- Link the privacy notice from the form footer.
- Give an escalated chat turn somewhere to land. `POST /api/chat` returns
  `escalate` and nothing reads it.
