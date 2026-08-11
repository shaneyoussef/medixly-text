# Medixly — Privacy Documents

Four documents required of a health information custodian under PHIPA.
Medixly is the custodian; there is no second party and no agent agreement.

Anything in `[SQUARE BRACKETS]` is a decision or detail only you can supply.
Nothing here is legal advice — this is a working draft to shorten a lawyer's
review, not to replace it.

---
---

# 1. Privacy Officer Designation

PHIPA s.15(3) requires a custodian to designate a contact person. In a
single-operator pharmacy that person is you; the obligation is to write it down
and publish the contact details, not to hire anyone.

**Designation**

`[YOUR FULL NAME]`, `[TITLE — e.g. Designated Manager / Owner]` of Medixly
Pharmacy, is designated as the contact person under s.15(3) of the *Personal
Health Information Protection Act, 2004*.

**Responsibilities**

The contact person is responsible for:

- ensuring compliance with PHIPA in the pharmacy's practices;
- responding to enquiries from the public about those practices;
- responding to requests from individuals for access to or correction of their
  records under ss.52–55;
- receiving and responding to complaints about the pharmacy's handling of
  personal health information;
- initiating and completing the breach protocol at §2 when a breach is
  suspected.

**Published contact**

    Privacy Officer, Medixly
    [MAILING ADDRESS]
    [PHONE]
    [EMAIL]

**Effective:** `[DATE]`
**Signed:** ______________________

**Review:** annually, or when the role changes hands. If a second person is ever
given access to patient records, this document is revised at the same time as
the access is granted — not afterwards.

---
---

# 2. Privacy Breach Protocol

A breach is any collection, use, disclosure, loss, theft, or unauthorised
access to personal health information that is not permitted by PHIPA. It
includes a misdirected email, a lost device, a record shown to the wrong
patient, and unauthorised access by a staff member — not only an external
attack.

## Step 1 — Contain (immediately)

- Stop the unauthorised access. Revoke keys, disable accounts, take a system
  offline if necessary.
- Retrieve or delete misdirected copies where possible.
- **Do not destroy evidence.** Preserve logs, emails, and the affected records
  as they are. The `audit_log` table is append-only for this reason.
- Record the time containment began.

## Step 2 — Investigate and record

Open a breach record capturing:

| Field | Detail |
|---|---|
| Date and time discovered | |
| Date and time of the breach itself | |
| How it was discovered | |
| What information was involved | |
| How many individuals affected | |
| Cause | |
| Whether the information was encrypted or otherwise unreadable | |
| Whether it has been recovered | |
| Containment steps taken | |

Consult the `audit_log` table — it records every view, creation, and status
change with a timestamp.

## Step 3 — Notify the affected individuals

**Required in every case.** PHIPA s.12(2): a custodian must notify the
individual at the first reasonable opportunity if their PHI is stolen, lost, or
used or disclosed without authority.

The notice must state what happened, what information was involved, what has
been done about it, and that the individual has a right to complain to the
Information and Privacy Commissioner of Ontario.

## Step 4 — Notify the Information and Privacy Commissioner

Notify the IPC where required — including, among other circumstances, use or
disclosure without authority, theft, further breaches of the same kind, and
where the breach is significant having regard to its sensitivity, the number of
individuals affected, and whether more than one custodian was involved.

    Information and Privacy Commissioner of Ontario
    2 Bloor Street East, Suite 1400, Toronto ON M4W 1A8
    1-800-387-0073
    ipc.on.ca

**When in doubt, notify.** Under-reporting is the more serious error.

## Step 5 — Notify the Ontario College of Pharmacists

Report where the College's requirements apply — check the current standards, as
reporting obligations for registrants are separate from the IPC's.

## Step 6 — Prevent recurrence

Identify the root cause. Change the practice, the system, or both. Record what
changed. Update the Privacy Impact Assessment if the system changed.

## Annual statistics

PHIPA requires custodians to report the annual number of breaches to the IPC
each March, for the preceding calendar year — including a nil report. Keep a
running count.

---
---

# 3. Retention and Disposal Schedule

## The rule that governs

**This corrects an assumption built into the system.** The `purge_old_payloads`
function was written with a two-year default. That is wrong for a pharmacy, and
by a wide margin.

Ontario pharmacies must retain patient records for **at least 10 years from the
last recorded professional pharmacy service to the patient, or 10 years after
the patient reached or would have reached age 18 — whichever is longer.** For a
patient who keeps using the pharmacy, the record is retained indefinitely,
because the 10-year clock restarts with every service.

Requirements are set under O. Reg. 264/16 of the *Drug and Pharmacies
Regulation Act*, ss.20–21, and the College's Record Retention, Disclosure and
Disposal Guideline.

So the conflict flagged in the PIA resolves clearly: **the College's
record-keeping obligation wins over privacy-minimising instincts.** PHIPA
requires you not to keep information longer than necessary; the College defines
what "necessary" means here, and it is a long time.

## Schedule

| Record | Retention | Basis |
|---|---|---|
| Transfer request from a patient who became a patient | 10 years from last service, or to age 28, whichever is longer | Part of the patient record |
| Request from someone who never became a patient | `[DECIDE — proposed: 2 years from submission]` | Not a patient record; keep only as long as needed for follow-up and dispute |
| Audit log entries | Retain for the life of the associated record | Needed to account for access |
| Consent records | With the record they relate to | Evidence of lawful collection |
| Notification emails | `[DECIDE — proposed: 12 months]` | Contain no PHI beyond a first name |

## System changes required

1. **Change the default** in `purge_old_payloads()` from 2 years. It must not
   run against records belonging to active patients.
2. **Add a flag** distinguishing requests that became patient records from those
   that did not — the two have completely different clocks.
3. **Do not schedule the purge job** until 1 and 2 are done. Deleting a record
   the College requires you to keep is a worse outcome than keeping one longer
   than ideal.

## Disposal

Destruction must be secure and irreversible. Record the date, what was
destroyed, and who authorised it. Keep destruction records permanently.

**Decisions needed:** the retention period for non-patient requests, and
confirmation with the College or a lawyer that a transfer request from someone
who never completed the transfer is not a patient record.

---
---

# 4. Privacy Notice

*Patient-facing. Publish on the website and link from every form.*

---

## How Medixly handles your information

Medixly is a health information custodian under Ontario's *Personal
Health Information Protection Act, 2004*. This notice explains what we collect
when you use our online services, why, and what rights you have.

### What we collect

When you submit a request online — such as a prescription transfer — we collect
your name, mobile number, date of birth, and details of the request itself.

We do not ask for your health card number, your medications, or your symptoms
through these forms. If you send us health details in a message or a free-text
field, we may need to record them as part of your patient record.

### Why we collect it

To identify you correctly, to carry out the service you asked for, and to
contact you about it. We do not use your information for marketing and we do
not sell it.

### Your consent

We ask for your express consent before collecting this information. You may
withdraw consent at any time by contacting us, although this may prevent us
from completing a request already in progress, and it does not require us to
delete records we are legally required to keep.

### Who can see it

Only pharmacy staff who need it to do their work. We also use service providers
to operate our systems, and you should know where they are:

- Your request records and any files you send us are stored in **Canada**.
- Our email notification provider is in the **United States** and receives only
  your first name and a reference number, never your health information.
- If you buy an over-the-counter product through us, **Shopify** handles that
  order and the payment. They receive your name, contact and delivery details and
  what you bought. They never receive a reason for the purchase, and we never send
  them anything about your health.
- When you send us a message, the text is read by an automated service that works
  out what you are asking for, so we can send you to the right form or to a
  pharmacist. `[CONFIRM WITH PRIVACY OFFICER — where this runs, and whether it
  needs its own consent.]`

We never pay for your information to be used for advertising, and we do not put
advertising or analytics trackers on the page where you message us.

### How we protect it

Information is encrypted in transit and at rest, access is restricted, and
every access to a record is logged.

**Please do not send health information by text message or ordinary email.**
Those channels are not secure. Use the secure forms we link to, or speak to us
directly.

### How long we keep it

Ontario law requires pharmacies to keep patient records for at least ten years
after the last service provided to you, and longer for records relating to
patients under 18. We securely destroy records once those periods pass.

### Your rights

You have the right to access your records, to ask us to correct them if they
are wrong, to withdraw consent, and to complain about how we handle your
information.

To exercise any of these, contact:

    Privacy Officer, Medixly
    [ADDRESS] · [PHONE] · [EMAIL]

If you are not satisfied with our response, you may contact the Information and
Privacy Commissioner of Ontario at 1-800-387-0073 or ipc.on.ca.

**Last updated:** `[DATE]`

---
---

# What is left

The fifth item is not a document you write:

**Request Supabase's data processing agreement.** They hold all of the patient
records. Ask their support or sales team for the DPA and the current SOC 2
report. The compliance paperwork sits behind a paid plan, so budget for that
before the pilot.

Then take all of this to a lawyer or privacy consultant qualified in Ontario
health privacy. The specific questions worth paying for:

1. Is the consent wording on the transfer form sufficient under PHIPA?
2. Is a transfer request from someone who never became a patient a patient
   record for retention purposes?
3. Does the marketing approach comply with the College's advertising standards?
4. Is the record of a patient buying a specific health product from us personal
   health information, given the reasoning in the PIA at §3? It decides whether
   Shopify is a service provider holding PHI.
5. Does automated classification of a patient's message need its own consent, or
   is it covered by consent to the service itself?
