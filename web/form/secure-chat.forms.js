/* ══════════════════════════════════════════════════════════════════════
   PLACEHOLDER — this is not the real secure-chat.forms.js.

   The real file carries the five form schemas (transfer, refill, upload,
   vaccine, minor ailment), the service rail, and the verbatim consent
   block. None of that is invented here: this file exists only so the
   page loads and the messaging half can be reviewed on a deploy preview.

   What that costs you until the real file lands:

     · the service rail renders empty — no way to start a request
     · nothing pushes a form card into the thread
     · no consent block, so nothing can be submitted at all

   `core` reads `SERVICES` at mount time and `FORMS` when a service chip
   or `requestForm()` fires, so both have to exist for the page to run.
   `consentBlock`, `CONSENT_ERROR` and `vaccineBy` are deliberately NOT
   stubbed — they are only reachable from inside a form card, which an
   empty `FORMS` prevents, and a stubbed consent block that silently
   rendered nothing would be a compliance failure rather than a bug.

   Replace this whole file. Do not merge into it.
   ═══════════════════════════════════════════════════════════════════ */

console.warn(
  '[SecureChat] secure-chat.forms.js is the placeholder — no services, no forms, no consent. ' +
  'The page is not submittable.'
);

const SERVICES = [];
const FORMS = {};
