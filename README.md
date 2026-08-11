# Medixly Text

Text-to-service patient intake for Ontario pharmacies.

A patient texts the pharmacy's number. An AI agent classifies the request and replies
with a secure link to the matching Medixly form. **SMS is the front door only** — all
protected health information (PHI) is collected on encrypted, Canadian-hosted forms.

The agent routes; it does not converse. It never asks for symptoms, never answers
a clinical question, and never suggests a product for one — a shopping message
with a symptom in it gets a pharmacist instead of a shelf. A pharmacist answers
everything the agent hands over. See [`docs/AGENT.md`](docs/AGENT.md).

## The rule everything else depends on

> No PHI ever travels over SMS. The text thread contains intent and links, nothing more.

This single constraint is what makes PHIPA and PIPEDA compliance tractable. Compliance
lives in the forms and the database; the messaging layer stays clean.

## Supported intents

| Intent | Destination |
|---|---|
| `REFILL` | Refill prescription form |
| `TRANSFER` | Transfer prescription form |
| `RX_UPLOAD` | Upload prescription form |
| `MINOR_AILMENT` | Minor ailment assessment |
| `PHARMACIST_CHAT` | Pharmacist callback request |
| `OTC_ORDER` | In-chat shop, on Shopify |
| `UNCLEAR` | One clarifying question, then human queue |

`TRANSFER` is the acquisition intent — it is the only one that gains a new patient,
so it gets built and polished first.

## Stack

- **SMS** — Twilio vanity toll-free number (SMS + voice enabled, MMS deliberately off)
- **Backend** — AWS Lambda + API Gateway, `ca-central-1` (Montreal)
- **Database** — RDS Postgres, encrypted at rest (KMS)
- **File storage** — S3 `ca-central-1`, presigned uploads
- **Classifier** — Anthropic API, strict JSON output
- **Secure email** — Hushmail for Healthcare
- **Monitoring** — CloudWatch (audit trail) + Sentry

### Why MMS is off

With MMS enabled, patients text photos of prescriptions — PHI landing in Twilio's US
storage instead of Canadian S3. Leaving it off keeps that door shut by default.
Photos go through the upload form.

## Channels

SMS is one adapter, not the architecture. A web chat widget runs the same classifier
and the same reply logic with no carrier and no verification, and is the fastest way
to test. Keep the intent layer transport-agnostic so a future agent-callable API is
another adapter rather than a rewrite.

## One pharmacy

Medixly is a single pharmacy running its own software, and the health information
custodian for everything the system holds. There is no client pharmacy, no agent
relationship and no tenant boundary to enforce.

Records are still keyed by `pharmacy_id` and the column stays. It costs nothing,
it keeps the audit log and the queue honest about which pharmacy a request
belongs to, and removing it would be churn against a schema that already works.
Treat it as one row, not as multi-tenancy.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — flow, modules, data model
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — PHIPA/PIPEDA controls checklist
- [`docs/CLASSIFIER.md`](docs/CLASSIFIER.md) — system prompt and output contract
- [`docs/AGENT.md`](docs/AGENT.md) — what the system does with a classification
- [`docs/SHOP.md`](docs/SHOP.md) — in-chat Shopify ordering, and its allowlist
- [`docs/PIA.md`](docs/PIA.md) — privacy impact assessment (draft, pre-pilot)
- [`docs/privacy-documents.md`](docs/privacy-documents.md) — the four documents PHIPA requires of a custodian
- [`docs/VOICE.md`](docs/VOICE.md) — voice transfer flow
- [`web/HANDOFF.md`](web/HANDOFF.md) — secure chat client: file map, design rules, tasks
- [`ROADMAP.md`](ROADMAP.md) — build phases

## Status

Pre-pilot, and not approved for real patient data — see [`docs/PIA.md`](docs/PIA.md) §10.

The patient chat client works in a browser: five forms — transfer, refill,
prescription upload, minor ailment assessment, pharmacist callback — each
paginated, validated, and reconciled against the fields `api/submit.ts` stores.
Plus an in-chat shop: product cards from Shopify, a basket, and checkout without
leaving the page.

Written but not yet run against a server: the submission endpoint, the classifier
and its test set, the routing agent, and the staff queue page. Nothing has been
deployed to Canadian infrastructure, which Phase 5 requires before the first real
patient.

Two things gate the forms regardless of infrastructure. The consent block is a
draft and needs the privacy officer; the minor ailment assessment's red-flag
questions must come from the pharmacy's clinical protocol and are deliberately
absent until they do. Both are in [`web/HANDOFF.md`](web/HANDOFF.md).

---

*Not legal advice. Have a Canadian privacy lawyer review before going live with real patients.*
