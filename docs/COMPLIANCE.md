# Compliance — PHIPA (Ontario) & PIPEDA

**Roles:** Medixly is the *health information custodian* under PHIPA — one
pharmacy running its own software. There is no second party: no agent
relationship, no electronic service provider standing between a pharmacy and its
records, and no data processing agreement with a client pharmacy, because there
is no client pharmacy. Medixly answers to its patients and to the Information and
Privacy Commissioner of Ontario directly.

That removes a party; it does not remove obligations. Every service this system
depends on — hosting, SMS, the classifier, secure email — is Medixly's service
provider, and the custodian stays accountable for each of them. Being the only
operator lowers the coordination cost, not the duty of care: the patients whose
health information this holds are not parties to that simplification.

## Controls checklist

- [ ] **First-contact consent.** Automatic reply on a patient's first message:
      messages are not secure, don't text health details, reply YES to continue,
      STOP to opt out. Consent timestamp logged.
- [ ] **No PHI over SMS.** The agent never asks for medication names, symptoms,
      health card numbers, or diagnoses by text.
- [ ] **No PHI echo.** If a patient volunteers health information, the reply never
      repeats it back, and the message body isn't retained past the audit window.
- [ ] **MMS disabled** so prescription photos can't land in US storage.
- [ ] **Data residency.** All PHI storage and processing in Canadian regions
      (`ca-central-1`). SMS transport is treated as untrusted infrastructure.
- [ ] **Encryption.** TLS in transit; KMS at rest; field-level encryption on
      health card numbers.
- [ ] **Access controls.** Pharmacy-scoped access. Session timeout on the
      pharmacist dashboard. Least-privilege IAM.
- [ ] **Audit log.** Append-only record of every access, send, and classification.
- [ ] **Written agreement with every service provider** that touches PHI —
      hosting, Twilio, Anthropic, Hushmail — and that same list disclosed to
      patients in the privacy notice. There is no client pharmacy to sign an
      agreement with; the accountability sits with Medixly either way.
- [ ] **Retention and deletion schedule.** Documented, automated, honouring
      patient deletion requests.
- [ ] **Privacy officer** named, with contact details published in the privacy
      notice. A custodian needs a named contact even when it is a one-person
      operation.
- [ ] **Breach protocol** including mandatory notification to the Information and
      Privacy Commissioner of Ontario.
- [ ] **Mandatory consent checkbox** on every patient-facing form — submit
      disabled until checked, timestamp logged.
- [ ] **Legal review** by a Canadian privacy lawyer before the first live patient.

## Test data vs real data

Everything before Phase 5 runs on fake patient data, so hosting location doesn't
matter during development. The move to Canadian infrastructure has to be complete
before a single real patient touches the system — not before the first test.

## Notes on specific vendors

**Twilio** — messages route through US infrastructure. Acceptable *only* because
the thread carries no PHI. This is the load-bearing assumption of the whole design;
if it ever stops being true, the compliance posture breaks.

**Anthropic API** — the classifier sees only the raw inbound text. By design that
text shouldn't contain PHI, but patients don't read disclaimers, so treat the
classifier as a system that may incidentally see health info and document it as a
subprocessor accordingly.

**Twilio AI Assistants** — not used, deliberately. It retains conversation history
and builds customer profiles on US infrastructure with an LLM subprocessor we
didn't choose. That runs directly against the retention and residency posture above.

**Hushmail for Healthcare** — Canadian servers, the Medixly standard for the
secure email leg. Pharmacist notifications should link to the dashboard rather
than embedding full PHI in the email body where practical.

**RPost / RMail** — optional, and not needed for the patient-facing flow since
Hushmail covers it. Where it earns its place: **outbound prescription transfer
requests to other pharmacies**, where a registered receipt gives court-admissible
proof of delivery if the receiving pharmacy claims the request never arrived.

## Toll-free verification

Mandatory before any SMS sends. Requires a CRA Business Number, issuing country,
and legal entity type. Describe the use case as prescription and appointment
notifications for a licensed pharmacy, with a clear opt-in description — vague or
marketing-flavoured descriptions get rejected.
