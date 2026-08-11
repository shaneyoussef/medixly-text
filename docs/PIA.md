# Privacy Impact Assessment

**System:** Medixly Text — patient intake for Ontario pharmacies
**Version:** 0.1 (draft, pre-pilot)
**Date:** August 2026
**Status:** Not approved for live patient data. See §10.

---

## 1. Purpose and scope

Medixly Text lets a patient request a pharmacy service without phoning or
attending in person. A patient submits a web form (later: SMS or voice); the
request is stored and appears in a queue the pharmacy works from.

Six request types are in scope: prescription transfer, refill, new prescription
upload, minor ailment assessment, pharmacist callback, and over-the-counter
order. **All six are implemented.** Five are forms that land in the pharmacy's
queue; the over-the-counter order is a Shopify basket and checkout inside the
chat, which is a different shape and is assessed separately at §8 and in
docs/SHOP.md. This assessment covers the implemented system.

Version 0.1 of this document was written when only transfer existed and says so
in places; §4 has been brought up to date and §3, §9 and §12 have not. The
assessment form is the reason that matters — see the note at the end of §4.

Out of scope: dispensing, clinical decision-making, billing, and any
integration with a pharmacy management system.

---

## 2. Roles and accountability

| Party | Role | Basis |
|---|---|---|
| Medixly | Health information custodian | PHIPA s.3(1) — operates a pharmacy within the meaning of the *Drug and Pharmacies Regulation Act* |
| Patient | Individual to whom the PHI relates | — |

There is no agent and no electronic service provider in this arrangement:
Medixly is a single pharmacy that built and runs its own intake system, so the
custodian and the operator are the same party. Nothing is handled "on the
custodian's behalf" — it is handled by the custodian.

The practical consequence is that accountability does not travel anywhere. There
is no instructing party to defer to, and no second organisation whose agreement
sets the limits of what may be done with the information. Every decision this
document records is Medixly's own, and answerable to the patient and to the
Information and Privacy Commissioner of Ontario.

Whether **PIPEDA** applies alongside PHIPA is an open question — Ontario's PHIPA
is recognised as substantially similar for health information held by a
custodian, which is the basis on which PIPEDA is generally displaced for that
information. The consent block on every patient-facing form currently names
PIPEDA. See §10 and the open question in `web/HANDOFF.md`; this needs the
privacy lawyer's answer before launch, not a guess here.

**Required before pilot:** a written agreement between Medixly and each
pharmacy setting out permitted uses, safeguards, breach notification, and
return or destruction of records on termination.

---

## 3. Is this personal health information?

**Yes — and this corrects an earlier working assumption.**

Earlier design notes described the transfer form as collecting "no health
information" because it asks for no symptoms, diagnoses, or medication names.
That reasoning does not survive contact with the statute. Under PHIPA s.4(1),
identifying information about an individual that relates to the provision of
health care to them is PHI. **The fact that a named, dated individual is
transferring prescriptions between pharmacies is itself information about the
provision of health care to them.**

Practical consequences:

- The full PHIPA safeguard, retention, and access regime applies to the
  `requests` table — not a lighter regime.
- The design principle "no PHI over SMS" remains correct and important, but it
  should be understood as *minimising* PHI in transit over unsecured channels,
  not as putting the system outside PHIPA.
- The distinction that still holds: the transfer form collects **low-sensitivity
  PHI** (identity plus the fact of a transfer). Minor ailment assessment will
  collect **high-sensitivity PHI** (symptoms, conditions) and warrants stricter
  handling when built.

---

## 4. Data inventory

### Collected from the patient

Shared by every form:

| Field | Purpose | Necessary? |
|---|---|---|
| Full name | Identify the patient at the releasing pharmacy | Yes |
| Mobile number | Contact about the request | Yes |
| Date of birth | Disambiguate patients with the same name | Yes |
| Consent flag and timestamp | Evidence of consent | Yes |
| Free-text notes | Optional context | Optional; field warns against health details on every form except the assessment |

Per form:

| Form | Field | Purpose | Sensitivity |
|---|---|---|---|
| Transfer | Current pharmacy | Know who to contact | Low |
| Transfer | Scope — all or some | Know whether to request all records or some | Low |
| Refill | Prescription number | Identify the prescription to refill | Low |
| Refill | Pickup or delivery | Fulfil the request | Low |
| Upload | Prescription image or PDF | The prescription itself | **High** |
| Upload | Prescriber name | Contact them if the prescription is unclear | Low |
| Assessment | Condition | Which minor ailment is being assessed | **High** |
| Assessment | Duration | Clinical context | **High** |
| Assessment | Prior treatment | Clinical context | **High** |
| Callback | Topic — a category, not a description | Route the callback to the right person | Low |
| Callback | Best time to call | Reach the patient | Low |

**Deliberately not collected:** health card number, medication names, diagnoses.
Enforced twice — the client asks for none of them, and the API declares a
whitelist per form and discards everything else before storage.

Medication names are the one worth spelling out, because two forms nearly needed
them and don't. Transfer asks whether to move all prescriptions or only some, and
never which; refill takes the number off the label and offers no "or describe it"
box. In both cases a pharmacist confirms the specifics with the patient instead. A
free-text field asking which prescriptions would be collecting drug names by
another route.

**The assessment changes the sensitivity of this system**, exactly as §3
anticipated. Condition, duration and prior treatment are symptoms and clinical
history, and an uploaded prescription image is a clinical record. §12's trigger
has fired: this document needs the rework it describes before the assessment form
is exposed to real patients, and the retention analysis at §9 should be revisited
for the image in particular.

### Generated by the system

Reference code, request status, staff notes, timestamps, audit log entries.

---

## 5. Data flows

```
Patient device
   |  HTTPS
   v
Static form  (Netlify CDN — no data stored; page assets only)
   |  HTTPS POST
   v
Edge function `submit`  (Supabase, ca-central-1)
   |
   |--> requests table        (Postgres, ca-central-1, encrypted at rest)
   |--> audit_log             (append-only)
   \--> notification email    (Resend, US) — reference + first name only, no PHI
                                            beyond the name; links to the queue

Pharmacy staff
   |  HTTPS + staff key
   v
Edge function `queue`  --> requests table

Over-the-counter order (a separate leg, no PHI in it)
Patient device
   |  HTTPS
   v
Edge function `shop`  --> Shopify Storefront API   (allowlisted collection only)
   |                          |
   |                          \--> cart + checkoutUrl
   v
Shopify checkout  (Shopify is merchant of record; no card data reaches us)
   \--> Shopify order: name, contact, delivery address, items
        NEVER a reason for the purchase
```

The chat page loads no Shopify script. Products arrive as JSON through our own
proxy and images from Shopify's CDN, so no third-party tag runs in the document
that holds a patient's conversation. See docs/SHOP.md for why that direction is
load-bearing rather than incidental.

**Residency:** patient request records are stored and processed in Canada
(`ca-central-1`, Montréal). Components outside Canada are addressed in §8, and
two of them now carry more than metadata: the classifier reads message text, and
Shopify holds over-the-counter order records. Risk 12 in §10 is no longer closed.

---

## 6. Consent

Consent is expressed, not implied. The submit button is disabled until the
patient ticks a checkbox whose text states what is collected, why, who it is
disclosed to, and that consent may be withdrawn. The API independently rejects
any submission without `consent.given === true` — the gate is not only in the
browser. Timestamp and method are stored on the record.

**Gap:** no mechanism yet for a patient to withdraw consent or request
correction or access after submission. Required before pilot (§10).

---

## 7. Safeguards

### Technical — implemented

- TLS in transit; AES-256 at rest (Supabase managed).
- Row-level security on `requests`, `audit_log`, and `pharmacies`, scoping rows
  to the owning pharmacy.
- `request_queue` view set to `security_invoker` so it cannot bypass RLS.
  *(This was a real defect found and fixed during assessment — the view would
  otherwise have exposed every pharmacy's requests to any authenticated
  reader.)*
- Field whitelisting on write; unknown fields discarded.
- Append-only audit log — `UPDATE` and `DELETE` revoked from `public`.
- Functions pinned to a fixed `search_path`.
- Notification emails contain no health information and no contact details —
  they point to the queue rather than carrying the record.
- Service-role keys held server-side only, never shipped to the browser.

### Technical — outstanding

- Rate limiting on public endpoints (`submit` is unauthenticated by necessity).
- Per-user authentication for staff (see §10).
- Tokenised, expiring links so a bare form URL is not sufficient to submit.

### Administrative — outstanding

Named privacy officer, written breach protocol, staff privacy training, signed
agreements with the pharmacy and with subprocessors.

---

## 8. Third parties and cross-border transfer

| Provider | Role | Location | PHI exposure |
|---|---|---|---|
| Supabase | Database, storage, compute | `ca-central-1` (Canada) | Full — all request records |
| Netlify | Static page hosting | US CDN | None stored; serves HTML only. Request metadata (IP, user agent) is visible to the CDN |
| Resend | Notification email | US | Patient first name only |
| Anthropic | Intent classification (not yet in production path) | US | Raw inbound message text when SMS launches |
| Twilio | SMS and voice (not yet live) | US routing | Message content — hence the no-PHI-in-SMS rule |
| Shopify | Over-the-counter orders and payment, in-chat | Canadian company, hosted largely outside Canada | Name, contact and delivery address, and which health products were bought. **No clinical context** — no order notes, tags or line attributes naming a condition |

PIPEDA permits cross-border transfer where comparable protection applies and
the practice is disclosed. Two items need attention:

1. **Resend receives a patient's first name.** Low sensitivity, but it is
   identifying information leaving the country. Either accept and disclose it,
   or change the notification to reference-only with no name at all — a
   one-line change, and the safer choice.
2. **Netlify sees IP addresses** of patients loading the form. This is
   unavoidable with any CDN and should simply be disclosed rather than treated
   as a defect.

All of the above must appear in the subprocessor list of the pharmacy
agreement and in the public privacy notice.

---

## 9. Retention, access, and disposal

A `purge_old_payloads()` function blanks request payloads and staff notes after
a configurable interval while preserving the reference and audit trail — so the
record of *that a request occurred* survives without the content.

**Gap:** the function exists; the policy does not. A retention period must be
chosen and written down, taking into account the pharmacy's own record-keeping
obligations under the *Pharmacy Act* and OCP requirements, which may exceed
what a privacy-minimising default would suggest. The function is not yet
scheduled to run.

**Gap:** no implemented process for a patient's right of access (PHIPA s.52) or
correction (s.55). At current volume this can be a documented manual procedure
rather than a feature.

---

## 10. Risk register

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | Shared staff key means the audit log cannot identify *who* accessed a record — PHIPA s.10(1) requires the custodian to account for access | **High** | Open. Blocks pilot. Replace with per-person accounts. |
| 2 | No agreement with the pharmacy defining Medixly's obligations as agent | **High** | Open. Blocks pilot. |
| 3 | No agreement or subprocessor disclosure with Supabase / Resend | **High** | Open. Request Supabase's DPA. |
| 4 | Staff queue reachable on the public internet behind one shared secret | **High** | Open. Add site-level password now; replace with real auth before pilot. |
| 5 | No breach protocol; IPC notification is mandatory under PHIPA s.12(2) | **High** | Open. Blocks pilot. |
| 6 | Retention period undefined and purge unscheduled | Medium | Open. |
| 7 | No access/correction procedure | Medium | Open. |
| 8 | `submit` endpoint unauthenticated and unthrottled — spam or enumeration | Medium | Open. |
| 9 | Patient first name transits to a US provider | Low | Open. Mitigate by removing the name from notifications. |
| 10 | Patient volunteers health details in the free-text notes field | Low | Mitigated — field warns against it. Monitor in pilot. |
| 13 | Assessment and upload forms collect high-sensitivity PHI; this document was written for low-sensitivity transfer data | **High** | Open. §12's rework is due before either form sees a real patient. |
| 14 | Consent block is a draft derived from the privacy notice, not lawyer-reviewed wording, and names PHIPA while the trust badge names PIPEDA | **High** | Open. Blocks pilot. Privacy officer, then item 8 below. |
| 15 | Minor ailment red-flag screening questions are not loaded, so the form cannot establish whether a pharmacist may prescribe | **High** | Open. Needs the pharmacy's clinical protocol. Blocks that form. |
| 16 | Shopify holds order records that may be low-sensitivity PHI, and hosts largely outside Canada — reopening the residency question §5 closed | **High** | Open. Request Shopify's DPA and disclose it in the privacy notice. |
| 17 | Products that may not lawfully be sold from an unattended cart (NAPRA Schedule II/III) could be exposed in the chat | **High** | Mitigated by an allowlist collection the pharmacist curates — but the collection does not exist yet, so nothing is sellable until they build it. Needs pharmacist sign-off. |
| 18 | An automated reply could recommend a product for a symptom, which is clinical advice | Medium | Mitigated — a shopping message flagged `contains_health_details` routes to a pharmacist and returns no product. Asserted in `test/agent.ts`. Depends on PHI-detection accuracy; see docs/SHOP.md. |
| 11 | View bypassing row-level security across pharmacies | — | **Closed** — fixed during this assessment. |
| 12 | Data residency | **High** | **Reopened.** Request records stay in `ca-central-1`, but the classifier (Anthropic) and the shop (Shopify) both process outside it. See risks 16 and the security section of docs/AGENT.md. |

---

## 11. Conditions before live patient data

All of the following, without exception:

1. Per-person staff authentication replacing the shared key.
2. Signed agreement with the pharmacy defining Medixly's role as agent.
3. Subprocessor agreements and a published subprocessor list.
4. Named privacy officer and a written breach protocol.
5. Documented retention schedule, and the purge job scheduled.
6. Documented access and correction procedure.
7. Rate limiting on public endpoints.
8. Review by a lawyer qualified in Ontario health privacy.

Item 8 is not a formality. Nothing in this document is legal advice; it is a
self-assessment prepared to make that review efficient and to make the gaps
visible rather than discovered later.

---

## 12. Review

This assessment is reviewed when a new request type is implemented, when a new
channel launches (SMS, voice), when a subprocessor changes, or annually —
whichever comes first.

Adding the **minor ailment** form is the most significant upcoming change: it
moves the system from low-sensitivity to high-sensitivity PHI and requires this
document to be substantially reworked before that form goes live.
