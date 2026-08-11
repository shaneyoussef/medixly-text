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

A pharmacist answers the thread. There is no agent in the page: the service rail
and the form cards are how a request starts. `secure-chat.agent.js` exists and is
not loaded — see [`../docs/AGENT.md`](../docs/AGENT.md).

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
- Add rate limiting to the `submit` and `chat` endpoints. `chat` spends money on
  every call.
- Link the privacy notice from the form footer.
- Give an escalated chat turn somewhere to land. `POST /api/chat` returns
  `escalate` and nothing reads it.
