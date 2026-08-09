# Secure chat — handoff

Patient secure messaging for **Old Park Pharmacy**, built on the Medixly design
system. This document is the source of truth for what exists, what's deliberately
missing, and what to build next.

---

## What exists

All files live in `web/form/`, which is the patient site's Netlify publish
directory — so the chat is served at that site's root. They were previously one
106KB `secure-chat.html`; the split version replaces it in place.

**Two files have not landed yet**, and both are currently stood up by a
placeholder so the page loads on a deploy preview. With the placeholder in
place there is no service rail, no form card and no consent block: **the page
cannot submit anything.** Replace both files wholesale; don't merge into them.

| File | What's in it | Landed |
| --- | --- | --- |
| `index.html` | Shell. Markup only, loads everything below. | yes |
| `ds-tokens.css` | Copy of the Medixly design tokens so the page opens standalone. In the app, drop it and link the real design system. | yes |
| `secure-chat.css` | All chat styling. | yes |
| `secure-chat.auth.css` | Sign-in gate styling. | yes |
| `secure-chat.core.js` | Helpers plus the `SecureChat` class — all UI behaviour. Read this first. | yes |
| `secure-chat.forms.js` | Form schemas, service rail, consent block. Most content edits happen here. | **placeholder** |
| `secure-chat.auth.js` | `AuthGate`: sign-in, patient-record link, passkeys, guest mode, idle lock. Transport contract at the bottom. | yes |
| `secure-chat.print.js` | `MedixlyPrint`: print/fax submission sheets. | **placeholder** |
| `secure-chat.demo.js` | Stub transport and boot. Replace to go live. | yes |

### Features built

Messaging with delivery/read states and tap-to-retry. Attachments via camera,
photo library or file, with client-side downscaling to 2048px. Voice notes with
waveform capture and playback. A horizontally scrolling service rail. Five
paginated form cards — transfer, refill, upload, vaccine booking, minor ailment
assessment — each 3–6 short pages ending in review, consent, submit.

The service rail and the five form cards are rendered by `core` but defined in
`forms`, so neither appears until that file lands.

### Load order matters

`core` → `forms` → `auth` → `print` → `demo`. Nothing is referenced at
evaluation time across files, but `demo` constructs everything.

---

## Design rules — non-negotiable

- Every value comes from a design token. No raw hex, no off-scale sizes.
- Four colour families only: paper, ink, teal, clay. No fifth hue, no gradients.
- One clay element per view — the primary button. Clay is also the wizard's
  active step marker and the required-field asterisk.
- Fonts: Poppins (display), Source Sans 3 (body), IBM Plex Mono (numbers, times,
  codes). Nothing else.
- Icons: Lucide, masked with `currentColor`. No emoji, ever.
- Buttons and fields are 48px. That's also the touch floor for anything tappable.
- Sentence case everywhere except proper nouns and clinical condition names.
- Shadows are paper-cut: short offset, low blur. No glows, no coloured borders.

**Fixed copy.** The consent block, the trust badge, and the framework names
(PIPEDA/Hushmail for Healthcare, HIPAA/Paubox) are verbatim strings. Never
paraphrase, shorten or "improve" them. Errors say what to do, not what broke.

`secure-chat.print.js` deliberately ignores all of the above — fax is 1-bit at
204x98 dpi, so that file is pure black on white. Leave it that way.

---

## Reconcile with the server first

The client form schemas in `secure-chat.forms.js` were built from the Medixly
product spec, **not** from this repo's API. The server is authoritative.

Before building anything new:

- Reconcile the form schemas against the intents and required-field maps in
  `api/submit.ts` (`TRANSFER`, `REFILL`, `RX_UPLOAD`, …). Flag any field the
  client collects that the server doesn't expect, and vice versa.
- Check consent handling against the `consent_given`, `consent_at` and
  `consent_method` columns in `db/schema.sql`. The client already captures all
  three; make sure the names and shapes line up.

---

## Architecture: the platform is a courier, not an archive

The pharmacy system is the record. This platform receives a submission,
generates a print/fax sheet, hands it off, and then holds a duplicate it can
discard. Everything below follows from that.

### Handoff model — build this

Every submission and attachment needs:

- an `ingested` flag and a pointer to the pharmacy record it landed in
- a `handoffAt` timestamp
- a SHA-256 hash of the generated sheet

A purge job fires **only** on ingested items. Anything not ingested after its
window **escalates to the pharmacy** — it is never silently deleted. Silent
deletion of an unhandled request is the worst failure mode in this system.

### Retention

| Data | Period |
| --- | --- |
| Submission payload, answers, signature | 30 days after handoff; 90-day hard cap |
| Prescription photos, voice audio | Purge on handoff; 7-day cap |
| Message text | 90 days (see caveat) |
| Read receipts, presence, typing | 30 days |
| Drafts, staged-but-unsent files, discarded recordings | 24 hours |
| Abandoned guest sessions with no submission | 30 days |
| **Handoff log** (metadata only, no clinical content) | **10 years** |
| Backups | 35-day cycle |

The handoff log holds: submission ID, patient ID, form type, submitted
timestamp, consent timestamp and method, sheet generated timestamp, faxed or
printed timestamp, document hash. Nothing clinical.

**Caveat on 90-day message text.** This holds only if pharmacist replies are
documented in the pharmacy system. If a dosing answer exists only in chat, day
91 creates a documentation gap. Spot check after a month of live use; raise to
12 months if things slip.

Retention periods are a draft for the pharmacy's privacy officer to confirm, not
legal advice. Ontario pharmacies are health information custodians under
**PHIPA** — see the open question below.

### Export

One endpoint assembling the platform's appendix to a patient record: profile,
messages inside the retention window, and handoff log entries. The pharmacy
system answers the substantive part of any patient request.

---

## Tasks

1. **Confirm the split page loads.** The shell has replaced the old monolith in
   place and was checked in Chromium against the real `core`, `auth` and `demo`
   files, with throwaway stubs standing in for the two that hadn't landed:
   history renders with day dividers, the composer flips mic to send, the attach
   sheet traps focus and closes on Escape, and a sent message runs sending →
   delivered → read. Re-run this against the real `forms` and `print` once they
   land — that is the check that counts.

2. **`SecureChat.prototype.setProfile(profile)`** in core — store `this.profile`,
   re-render open form cards.

3. **`identity` field type** in `fieldEl()`. With a non-guest profile, render a
   confirm row — "We'll use: {name} · {phone} · {email}" — with a Change link
   that expands to the fields. Guest or incomplete profile renders fields
   normally. Then in `secure-chat.forms.js`, collapse the "About you" and "How
   to reach you" pages of `transfer`, `refill`, `upload` and `vaccine` into one
   `identity` page. Removes a page from each flow.

4. **Never prefill consent or the assessment signature.** Each submission needs
   its own consent record with its own timestamp. Not an optimisation for later.

5. **Wire `AuthGate`** in `secure-chat.demo.js` against a stub `auth` matching
   the contract in `secure-chat.auth.js`. Guest mode shows no transcript.

6. **Server side** under `api/` — extend what's there, match its conventions.
   Auth contract endpoints plus `POST /api/chat/send`, `GET /api/chat/stream`
   (SSE), `POST /api/chat/upload`, `POST /api/forms/:id/sheet`, and
   `GET /api/patients/:id/export`. Apply the six numbered rules in the
   `secure-chat.auth.js` footer — security requirements, not suggestions.

7. **Generate the print sheet server-side** at submission. A document carrying a
   consent timestamp is evidence and must not be assembled where the patient
   could alter it. `MedixlyPrint.html()` returns the same markup for a
   server-side PDF renderer.

8. **Handoff flags, purge job, escalation** per the model above.

9. **Voice note transcription** server-side. This is an accessibility
   requirement, not a nice-to-have — a deaf patient or pharmacist cannot read a
   voice note today. Render the transcript under the waveform; the print sheet
   already expects a `transcript` field.

10. **Barcode of the submission ID** on the print sheet (Code 128), so sheets
    scan into the pharmacy system without typing.

11. ~~**Netlify publish directories.**~~ Done. `web/form/` now exists and holds
    the whole chat client, with the shell renamed `index.html` so it serves at
    the site root. Publishing `web/` itself was never an option — it would have
    put the staff queue on the public site.

---

## Known gaps — do not paper over

**`SCREENING` in `secure-chat.forms.js` is deliberately empty.** Step 4 of the
minor ailment assessment needs five condition-specific yes/no red-flag questions
for each of 16 conditions. These determine whether a pharmacist may assess and
prescribe. They must come from the pharmacy's own clinical protocol. **Do not
invent them.** The visible "not loaded yet" notice stays until real ones are
supplied.

**PHI transport.** Message bodies and attachments must travel over Hushmail for
Healthcare, not a generic object store. The `URL.createObjectURL` stub in
`secure-chat.demo.js` must not ship.

**Vaccine inventory** is hardcoded in `secure-chat.forms.js`. It belongs to the
pharmacist dashboard.

**Delivery method casing.** The spec writes "Store Pickup" / "Local Delivery";
the design system mandates sentence case, so they render as "Store pickup" /
"Local delivery". Revert if those strings feed a pharmacy-side system.

---

## Open question for the pharmacy

The consent block names **PIPEDA**. Ontario pharmacies are health information
custodians under **PHIPA**, and Ontario record retention is a minimum of 10
years from the last professional service, or until 10 years after the patient
would have reached 18, whichever is longer. If Old Park is in Ontario, the
verbatim consent string may name the wrong statute — and it appears on every
form. Confirm with the pharmacy's privacy officer before launch.

---

## Ask before

Changing any consent or compliance wording. Adding a colour or a font. Storing
PHI anywhere new. Inventing clinical content.
