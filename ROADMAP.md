# Roadmap

Ordered so nothing waits on a phone number or a carrier approval.

## Phase 0 — Paperwork (runs in the background, blocks nothing)
- [ ] Paid Twilio account (trial accounts can't complete verification)
- [ ] Search 833 / 844 / 855 for the vanity toll-free number
- [ ] CRA Business Number in hand — required for toll-free verification
- [ ] Submit toll-free verification (SMS + voice enabled, MMS off)
- [ ] Hushmail for Healthcare account
- [ ] Written agreements with the service providers that touch PHI (hosting,
      Twilio, Anthropic, Hushmail) — not with client pharmacies; there are none

Toll-free verification is mandatory: unverified numbers are blocked outright.
Missing business registration details is the most common rejection reason.

## Phase 1 — Prove the loop without a number
- [x] Chat page with a working service rail and five submittable forms
- [x] Client reconciled against `api/submit.ts` — every field maps to a key the
      server stores
- [ ] Test with fake patient data only
- [ ] Watch a real person use it before building anything else

A pharmacist answers the thread to start with. The routing agent is written and
parked — see `docs/AGENT.md` for what it would take to switch on.

This becomes a permanent chat widget on the pharmacy site, not a throwaway rig.

## Phase 2 — Classifier
- [ ] Run the test set in `test/messages.json`
- [ ] Review every miss by hand
- [ ] Tune the confidence threshold
- [ ] Target: zero unsafe misses (clinical requests routed to self-serve forms)
- [ ] Pharmacy sign-off on the emergency tripwire list in `api/agent.ts`

Raw accuracy is the wrong target. A refill that lands on PHARMACIST_CHAT is fine.
A clinical concern that lands on an OTC form is not.

## Phase 3 — The transfer loop
- [x] Transfer form (the acquisition intent — built first)
- [x] Database table for submissions
- [ ] Deploy `POST /api/submit` and submit one request end to end
- [ ] `sendMail()` is a stub that throws — wire Hushmail or SES
- [ ] Normalise phone numbers in `api/submit.ts`; it rejects "+1 416 555 0100"
- [ ] Simple queue page to view and mark requests done
- [ ] Privacy officer sign-off on the consent block
- [ ] Red-flag screening questions from the pharmacy's clinical protocol,
      before the assessment form is exposed to anyone real

One form, one table, one email, one list. The other four forms are built and
are copies with different fields, exactly as predicted.

## Phase 4 — SMS adapter
- [ ] Twilio webhook with signature verification
- [ ] Consent + STOP/HELP handling
- [ ] Tokenized short links, 72h expiry
- [ ] Point the toll-free number at the webhook

By this point the system already works. The number is a config change.

## Phase 5 — Move to Canadian infrastructure
- [ ] AWS `ca-central-1` — API, RDS, S3
- [ ] Encryption at rest, field-level on health card numbers
- [ ] Audit logging
- [ ] Retention and deletion policy, automated

Must be complete before the first real patient. Test data can live anywhere.

## Phase 6 — Pilot
- [ ] Staff-only testing for two weeks
- [ ] Review every classification by hand
- [ ] Privacy lawyer review
- [ ] Then open to real patients

## Open decisions
- Short domain for links
- Human queue: dashboard tab, or SMS forward to the pharmacist's phone?
- Where requests actually land so staff see them — dashboard, counter phone, or fax.
  Ask the pilot pharmacy before building the pretty version.
- Bilingual replies — English-only at launch, or French from day one?
- RPost/RMail for outbound transfer requests to other pharmacies (registered
  proof of delivery) — pilot or defer?
- Pharmacy management system integration (Kroll, Nexxsys, WinRx) — the endgame
  that turns this from an intake form into infrastructure. Needs volume first.
