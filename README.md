# Medixly Text

Text-to-service patient intake for Ontario pharmacies.

A patient texts the pharmacy's number. An AI agent classifies the request and replies
with a secure link to the matching Medixly form. **SMS is the front door only** — all
protected health information (PHI) is collected on encrypted, Canadian-hosted forms.

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
| `OTC_ORDER` | OTC / wellness store |
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

## Multi-tenancy

Every record is keyed by `pharmacy_id`. One deployment serves all Medixly pharmacies.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — flow, modules, data model
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — PHIPA/PIPEDA controls checklist
- [`docs/CLASSIFIER.md`](docs/CLASSIFIER.md) — system prompt and output contract
- [`ROADMAP.md`](ROADMAP.md) — build phases

## Status

Pre-build. Architecture approved. Classifier and test set written, not yet run.

---

*Not legal advice. Have a Canadian privacy lawyer review before going live with real patients.*
