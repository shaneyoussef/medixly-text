# Secure chat — handoff

Patient secure messaging for **Medixly**, built on the Medixly design
system. This document is the source of truth for what exists, what's deliberately
missing, and what to build next.

---

## What exists

All files live in `web/form/`, which is the patient site's Netlify publish
directory — so the chat is served at that site's root. They were previously one
106KB `secure-chat.html`; the split version replaces it in place.

`secure-chat.forms.js` has landed, so the rail, the form cards and the consent
block are real and **the page submits.** `secure-chat.print.js` is still a
placeholder — no print or fax sheet can be generated. Replace it wholesale;
don't merge into it.

| File | What's in it | Landed |
| --- | --- | --- |
| `index.html` | Shell. Markup only, loads everything below. | yes |
| `ds-tokens.css` | Copy of the Medixly design tokens so the page opens standalone. In the app, drop it and link the real design system. | yes |
| `secure-chat.css` | All chat styling. | yes |
| `secure-chat.auth.css` | Sign-in card styling, plus the rules that hide the transcript for a guest, an unlinked account and the idle lock. | yes |
| `secure-chat.core.js` | Helpers plus the `SecureChat` class — all UI behaviour. Read this first. | yes |
| `secure-chat.forms.js` | Form schemas, service rail, consent block. Most content edits happen here. | yes |
| `secure-chat.auth.js` | `AuthGate`: sign-up, log in, password reset, passkeys, guest mode, idle lock. Transport contract at the bottom. | yes |
| `secure-chat.shop.js` | `MedixlyShop`: product search, basket, Shopify checkout. | yes |
| `secure-chat.agent.js` | `MedixlyAgent`: posts each message to `POST /api/chat` and applies the decision. | yes |
| `secure-chat.print.js` | `MedixlyPrint`: print/fax submission sheets. | **placeholder** |
| `secure-chat.demo.js` | Stub transport, the submission mapper, boot. Replace the transport to go live; keep the mapper. | yes |
| `img/pharmacist.png` | The illustration on the sign-up and log-in screens. Recoloured to the palette before it was committed — see below. | yes |

The agent routes and a pharmacist answers whatever it hands over. It never
suggests a product for a symptom — see [`../docs/AGENT.md`](../docs/AGENT.md)
and [`../docs/SHOP.md`](../docs/SHOP.md).

`img/` is the only asset directory, and `netlify.toml` publishes `web/form`, so
`img/pharmacist.png` is served from `/img/`. The committed file is not the
original artwork: it arrived as black strokes on opaque white, and both of those
are colours the palette doesn't contain, so its ink was remapped to `--ink-700`
and its fill to `--paper-50` and it was quantised to 64 colours (26 KB). Bake any
replacement the same way rather than reaching for a CSS `filter`.

One trap worth naming, because it looks like the obvious approach and isn't: this
illustration cannot be treated as an alpha mask the way `.mx-icon` treats every
lucide glyph. Its white fill is opaque and load-bearing — it is what stops the
shelf showing through the pharmacist's coat — so masking by alpha and tinting
collapses her into a solid silhouette.

### Features built

Messaging with delivery/read states and tap-to-retry. Attachments via camera,
photo library or file, with client-side downscaling to 2048px. Voice notes with
waveform capture and playback. A horizontally scrolling service rail. Five
paginated form cards — transfer, refill, prescription upload, minor ailment
assessment, pharmacist callback — each 3 to 5 short pages ending in review,
consent, submit.

Identity answers arrive prefilled for a signed-in patient. Consent never does.

Over-the-counter ordering: product cards, a basket with a quantity stepper, and
Shopify checkout inside the page. Products come *into* the chat rather than the
chat going into the storefront, which keeps every third-party storefront script
out of the document that holds a health conversation — [`../docs/SHOP.md`](../docs/SHOP.md)
explains why that direction is load-bearing.

### Load order matters

`core` → `forms` → `auth` → `shop` → `agent` → `print` → `demo`. Nothing is
referenced at evaluation time across files, but `demo` constructs everything.

### The forms are data, the markup is core's

`forms.js` touches the DOM in exactly one place — `consentBlock()`. Everything
else is schema, and `core` builds the elements from it. So a new field type is a
change to `fieldEl()` in core; a new question is a change to `forms.js` alone,
with no markup and no CSS.

Five exports and `core` reads nothing else: `SERVICES`, `FORMS`,
`consentBlock()`, `CONSENT_ERROR`, `vaccineBy()`. Declaration order matters —
`FORMS` is an object literal, so its option lists have to be declared above it.

### Reconciled against the server

`api/submit.ts` whitelists per intent and silently drops anything else, so the
client now collects only what that endpoint stores. Three things came out of
doing that reconciliation, and all three are load-bearing:

- **No medication names anywhere.** `docs/PIA.md` §4 lists them under
  "deliberately not collected", so the transfer form's `scope` is all-or-some
  with no "which ones" box, and the refill form takes a prescription number with
  no "or describe it" field. A free text box asking which prescriptions is
  asking for drug names by another route, and collecting them would move both
  forms from low- to high-sensitivity PHI.
- **`RX_UPLOAD` needs a stored path, not a blob.** `file_path` is required and
  the server writes whatever it is handed, so the transport uploads first and
  passes the returned path. The demo's `URL.createObjectURL` stub puts a `blob:`
  URL in that field, which is dead the moment the tab closes — that stub must
  not ship.
- **No assessment signature.** `MINOR_AILMENT` has no column for one, so the
  consent record with its own timestamp is the attestation. A signature field
  would have been collected and discarded.

Also found: `api/submit.ts` rejects a phone number that carries a country code,
because `digits()` requires exactly ten. Patients write their own number as
"+1 416 555 0100". `tenDigits()` in core drops a leading 1 and the mapper sends
ten digits, so the client no longer trips it — **but the server should do the
same normalisation**, or the SMS and voice adapters will hit it.

### The submission mapper

`toSubmission()` in `secure-chat.demo.js` is the seam the client and server meet
at, and it is not demo scaffolding — keep it when the transport is replaced. It
maps client field names to the server's whitelisted keys, normalises the phone
number, and stamps consent. A field that isn't in that table is a field that
never gets stored.

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

Done for the five forms that ship — the findings are under "Reconciled against
the server" above. The rule still stands for anything new: `api/submit.ts` is
authoritative, it whitelists per intent, and a field it doesn't recognise is a
field that never gets stored. Check `db/schema.sql` for the column before adding
the question.

Consent lines up: the client sends `{ given, at, method }` and the server stores
`consent_given`, `consent_at`, `consent_method`, rejecting anything without
`given === true`.

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

1. ~~**Confirm the split page loads.**~~ Done, and re-run against the real
   `forms.js` in Chromium: the rail renders five chips and each opens its card,
   history shows day dividers, the composer flips mic to send, the attach sheet
   traps focus and closes on Escape, and a sent message runs sending →
   delivered → read. All five forms were walked end to end — per-field
   validation with focus moving to the first bad field, an Edit link from the
   review page jumping back, the consent gate, and the submitted receipt — and
   every mapped payload was checked against `api/submit.ts`'s whitelist. Worth
   re-running once `print` lands.

2. ~~**`SecureChat.prototype.setProfile(profile)`** in core~~ Done. Stores the
   profile and drops any unsubmitted form card from the cache so it rebuilds.
   Submitted cards are receipts and are left alone. Nothing carries consent
   across — see task 4.

3. ~~**One identity page per form**~~ Done, but not the way this task
   described it, and the deviation is deliberate. The five forms share one
   "About you" page, and `seedIdentity()` in core prefills name, phone and date
   of birth from the signed-in profile — so nobody retypes what the pharmacy
   holds, which was the point.

   What is *not* built is the confirm row — "We'll use: {name} · {phone} ·
   {email}" with a Change link. Two reasons. It fights the machinery: the review
   page and `validate()` both iterate a step's declared fields and read
   `m.values[f.name]`, so a composite field would drop identity off the review
   summary and out of validation. And it named an email field, which the server
   has no column for — showing an address in a submission summary implies it
   travels with the submission when it doesn't. Prefilled editable fields give
   the same saving with none of that.

4. **Never prefill consent or the assessment signature.** Each submission needs
   its own consent record with its own timestamp. Not an optimisation for later.

5. ~~**Wire `AuthGate`** in `secure-chat.demo.js`~~ Done, against a stub `auth`
   implementing every contract method. Verified in Chromium: welcome → log in →
   wrong password errors → forgot password → sign up → short password rejected →
   link → chat, plus code → wrong code errors, and guest hides the transcript.
   The stub resolves everything in the browser and verifies nothing — it accepts
   any password — so it demonstrates the screens and nothing about auth. The
   twelve rules in the `secure-chat.auth.js` footer are all outstanding server
   work; 7 to 12 exist only because there are now passwords.

   **The identifier is collected on the first screen**, phone or email in one
   field, and carried into the create-account form — so the welcome screen is
   one field and one button rather than a menu of ways in. A number lands in a
   prefilled Mobile field; an address lands in Email. The mobile field is only
   rendered when they actually gave us a number, since every form already
   collects one per request.

   `opts.legal` needs `{ terms, privacy }` URLs. Without them the agreement
   line still renders but its two document names are plain text and a console
   warning fires — a sentence saying someone agreed to documents they cannot
   open is worse than no sentence, and these are two of the four documents
   PHIPA requires (see `../docs/privacy-documents.md`). **Neither page exists
   yet.**

   **The card lives in the thread, not over it.** `AuthGate` inserts itself
   into `[data-log]` ahead of `[data-stream]`, so it reads as the opening
   message and anything the patient opens afterwards lands underneath it. The
   chat is whole the entire time — header, service rail and composer all live
   — and tapping a service before signing in opens that form and submits it,
   because every form carries its own identity fields and its own consent.
   Signing in buys message history and not retyping yourself; it is not a toll
   gate on the service.

   Two consequences for whoever wires the server. **History is the server's
   job, not the CSS's**: an unauthenticated client must be sent no transcript
   at all, exactly as the demo's `onSession` models. The `is-guest` and
   `is-unlinked` rules are a second line for sessions that exist but have no
   record attached. And `is-locked` is the strict one — it hides forms and the
   notice too, because a half-filled assessment is what a locked screen is for.

   Never put the card back inside `[data-stream]`. `render()` calls
   `replaceChildren()` on that node and would delete it.

   **Nothing asks for a health card number or a date of birth.** There was a
   "Confirm it's you" screen that did, standing between signing up and seeing
   any messages, and it is gone. It collected the one identifier `docs/PIA.md`
   §4 says is never collected, and it wasn't even a good check — those two
   details are exactly what someone impersonating a patient would already have.

   What replaced it is `profile.linked`. A new account is `linked: false`,
   opens the chat, and sees **no message history** (`is-unlinked`, the same CSS
   rule as guest mode). Requests still go through, because every form carries
   its own identity fields and its own consent. The pharmacy attaches the
   record from their side, against someone they have already identified. Do not
   reintroduce a self-serve link endpoint — that is a lookup against real
   patient records with attacker-supplied details.

   Face ID appears on **log in and never on sign up**. `passkeyAuth()` asks the
   device for a credential enrolled here earlier, so on a sign-up screen it can
   only fail — it is a sign-in method, not a way to create an account.
   Enrollment is offered once, on `passkeyScreen()`, after the record link.

   Two things about the gate are decisions, not styling. **A password is the
   one credential we store ourselves**, so it is the one that can leak — the
   code and passkey paths never had that exposure. And rule 12 is the one that
   keeps a password from being a downgrade: a password alone must not open a
   transcript on a new device, exactly as Google and a texted code don't.
   **Apple sign-in** is offered only when `auth.appleSignIn` exists, so the
   button stays hidden until someone builds that half.

6. **Server side** under `api/` — extend what's there, match its conventions.
   `POST /api/chat` is written (`api/chat.ts`) and takes the place of
   `/api/chat/send`: it classifies, replies, and is the delivery receipt. It is
   not deployed, does not persist the thread, has no rate limit, and its
   `escalate` flag has nowhere to land — see the footer of that file.

   Still to build: the auth contract endpoints, a way for staff to set
   `linked` on an account, `GET /api/chat/stream` (SSE),
   `POST /api/chat/upload`, `POST /api/forms/:id/sheet`, and
   `GET /api/patients/:id/export`. Apply the twelve numbered rules in the
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
for each of the 16 conditions. These determine whether a pharmacist may assess
and prescribe, or whether the patient needs a physician or an emergency
department. They must come from the pharmacy's own clinical protocol. **Do not
invent them** — plausible-looking questions would be the most dangerous thing in
this codebase, because a patient who should have been sent to hospital would get
a form that looked complete. Every condition currently falls through to a visible
"not loaded yet" notice, keyed by the exact strings in `CONDITIONS`.

**The consent block is a draft.** `web/HANDOFF.md` called it a verbatim fixed
string, but the file carrying that string never landed here, so there was no
original to reproduce. What ships is derived from the privacy notice in
`docs/privacy-documents.md` §4 rather than invented, and it **needs the privacy
officer's sign-off before a real patient sees it.** Once signed off it becomes
fixed copy like the rest.

It also names **PHIPA**, while the trust badge under the composer names
**PIPEDA** because that string comes from `COUNTRY` in `secure-chat.core.js`.
Both cannot be right — see the open question below, and change them together.

**No vaccine form, and no OTC form.** Not an oversight in the client: there is
nowhere for either to land. `request_intent` in `db/schema.sql` has six values
and vaccine booking is not one, so `api/submit.ts` would reject a booking as an
unknown request type — a form that collects a patient's details and then fails is
worse than no form. `OTC_ORDER` does exist server-side, but the storefront it
should point at doesn't. Vaccines need the pharmacy's decision, then a migration
plus an `api/submit.ts` entry. `vaccineBy()` still ships because `core` references
it for the `pool` and `days` field types; it returns null and warns.

**Vaccine inventory** belongs to the pharmacist dashboard, not hardcoded in the
client, whenever that form is built.

**PHI transport.** Message bodies and attachments must travel over Hushmail for
Healthcare, not a generic object store. The `URL.createObjectURL` stub in
`secure-chat.demo.js` must not ship — and on `RX_UPLOAD` it is worse than a stub,
because the `blob:` URL it produces is written to `file_path` and is dead as soon
as the tab closes.

**`firstIncompleteStep()` is currently unreachable.** It guards the case where
editing an earlier page leaves a required answer blank on a page you then skip
past. None of the five forms have cross-step `showWhen` dependencies, and
`Continue` refuses to advance past a blank required field, so there is no path to
it today. Keep it — the moment a form gets a conditional page, it matters again.

**No `chat-eligible` collection exists yet.** Nothing is sellable in the chat
until the pharmacist creates that Shopify collection and puts products in it. The
proxy logs that it can't find the collection and returns an empty shelf, which is
the correct failure — never the whole catalogue.

**Guest mode used to hide form cards.** `.is-guest .mx-log .mx-msg` matched every
bubble, cards included, so a guest could tap a rail chip and see nothing appear.
Form and shop cards are now exempt. Worth remembering if that selector is ever
widened again.

**Delivery method casing.** The spec writes "Store Pickup" / "Local Delivery";
the design system mandates sentence case, so they render as "Store pickup" /
"Local delivery". Revert if those strings feed a pharmacy-side system that
matches on them.

---

## Open question for the pharmacy

The consent block names **PIPEDA**. Ontario pharmacies are health information
custodians under **PHIPA**, and Ontario record retention is a minimum of 10
years from the last professional service, or until 10 years after the patient
would have reached 18, whichever is longer. If Medixly is in Ontario, the
verbatim consent string may name the wrong statute — and it appears on every
form. Confirm with the pharmacy's privacy officer before launch.

---

## Ask before

Changing any consent or compliance wording. Adding a colour or a font. Storing
PHI anywhere new. Inventing clinical content.
