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
`index.html`. It is **not submittable yet** — `secure-chat.forms.js` and
`secure-chat.print.js` are placeholders, so there is no service rail, no form
card and no consent block. See [`HANDOFF.md`](HANDOFF.md).

Messages are answered by the agent (`secure-chat.agent.js` → `POST /api/chat`),
which classifies each one and opens the matching form card. That endpoint isn't
deployed, so the page currently routes against a keyword stub in
`secure-chat.demo.js` — it shows the behaviour and demonstrates nothing about
classification. See [`../docs/AGENT.md`](../docs/AGENT.md).

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
