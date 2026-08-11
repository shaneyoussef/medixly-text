/* ════════════════════════════════════════════════════════════════════
   Form schemas, the service rail, and the consent block.

   Data only. `core` builds every element from what's here, so nothing in
   this file touches the DOM except `consentBlock()`. That means no markup
   to keep in sync and no new CSS — every class already exists in
   secure-chat.css.

   Five exports, and `core` reads nothing else:

     SERVICES      the rail above the composer
     FORMS         the form cards
     consentBlock  the consent text, appended after its checkbox
     CONSENT_ERROR shown when someone submits without ticking it
     vaccineBy     vaccine inventory lookup — see the note at the bottom

   Declaration order matters: FORMS is an object literal, so anything it
   reads — the option lists, the shared fields — has to be declared above
   it or the file dies on load.

   ── Reconciled against api/submit.ts ──────────────────────────────
   The server is authoritative and it whitelists: anything not on a form's
   `fields` list is dropped before storage rather than saved. So every
   value collected here maps to a key that endpoint accepts, and nothing
   is collected that it would silently discard. The mapping itself lives
   with the transport, in secure-chat.demo.js.

   What that ruled out, deliberately:

     · Medication names, anywhere. docs/PIA.md §4 lists them under
       "deliberately not collected". So `scope` on the transfer form is a
       choice between all and some and nothing more — no "which ones"
       box, because a free text box asking which prescriptions is asking
       for medication names by another route. A pharmacist confirms which
       ones out loud. Same reason the refill form asks for a prescription
       number and offers no "or describe it" field. Collecting names would
       move both forms from low- to high-sensitivity PHI and invalidate
       that section of the PIA.
     · A separate phone or address for the releasing pharmacy. TRANSFER
       accepts from_pharmacy, scope and notes; a fourth field would be
       thrown away.
     · An assessment signature. MINOR_AILMENT has no column for one, so
       the consent record — with its own timestamp — is the attestation.
   ════════════════════════════════════════════════════════════════════ */

/* ── The rail ─────────────────────────────────────────────────────────
   Every chip carries `form`, not `prefill`, so a tap opens the card
   directly — nothing is sent and no message leaves the device to start a
   request. `prefill` chips exist in core for chips that should write into
   the composer instead; none are needed here.
   ─────────────────────────────────────────────────────────────────── */

const SERVICES = [
  { icon: 'repeat',      label: 'Transfer prescriptions', form: 'transfer' },
  { icon: 'pill',        label: 'Refill',                 form: 'refill'   },
  { icon: 'camera',      label: 'Send a prescription',    form: 'upload'   },
  { icon: 'stethoscope', label: 'Minor ailment',          form: 'ailment'  },
  { icon: 'phone',       label: 'Speak to a pharmacist',  form: 'callback' },
  // `shop: true` runs a product search locally. Browsing the shelf sends no
  // message and involves no model \u2014 see docs/SHOP.md.
  { icon: 'shopping-bag', label: 'Shop the shelf',        shop: true, query: '' }
];

/* ── Option lists ─────────────────────────────────────────────────────
   The conditions are the sixteen an Ontario pharmacist may assess and
   prescribe for, copied from the list already in api/classify.ts's system
   prompt rather than written fresh — so the classifier and the form can't
   drift into disagreeing about scope.
   ─────────────────────────────────────────────────────────────────── */

const CONDITIONS = [
  'Acne',
  'Allergic rhinitis (hay fever)',
  'Cold sores',
  'Conjunctivitis (pink eye)',
  'Dermatitis',
  'GERD or heartburn',
  'Hemorrhoids',
  'Impetigo',
  'Insect bites and hives',
  'Menstrual cramps',
  'Muscle sprains and strains',
  'Nausea and vomiting in pregnancy',
  'Oral thrush',
  'Tick bites',
  'Urinary tract infection',
  'Yeast infection'
];

const DURATIONS = [
  'Today',
  '2 to 3 days',
  'About a week',
  'One to four weeks',
  'Longer than a month',
  'It keeps coming back'
];

const TOPICS = [
  'A medication I\u2019m taking',
  'Starting something new',
  'Two medications together',
  'A side effect',
  'A dose I missed or got wrong',
  'Something else'
];

// docs/VOICE.md and the spec write these as "Store Pickup" / "Local Delivery".
// The design system mandates sentence case, so they render like this. Revert if
// these strings ever feed a pharmacy-side system that matches on them.
const DELIVERY = ['Store pickup', 'Local delivery'];

const CALL_TIMES = ['Morning', 'Afternoon', 'Evening', 'Any time'];

/* ── Screening — deliberately empty ───────────────────────────────────
   Step 4 of the assessment needs condition-specific red-flag questions:
   the ones that decide whether a pharmacist may assess and prescribe at
   all, or whether the patient needs a physician or an emergency
   department.

   Those are clinical content. They must come from the pharmacy's own
   protocol, and inventing plausible-looking ones would be the most
   dangerous thing in this codebase — a patient who should have been sent
   to hospital would instead get a form that looked complete.

   So `SCREENING` stays empty and every condition falls through to the
   notice below, which the patient can see. The assessment is not a
   clinical document until real questions are supplied here, keyed by the
   exact strings in CONDITIONS above.
   ─────────────────────────────────────────────────────────────────── */

const SCREENING = {};

const SCREENING_NOT_LOADED = {
  name: 'screeningUnavailable',
  type: 'notice',
  text: 'The safety questions for this condition aren\u2019t loaded yet, so a pharmacist will go through them with you instead of this form. You can still send everything else — it just means we\u2019ll be in touch before the assessment is finished.'
};

/* ── Shared fields ────────────────────────────────────────────────── */

// The three the server stores on every request, and the only three. Email is
// not among them: `requests` has no column for it, so a field asking for one
// would imply it travels with the submission when it doesn't.
//
// These arrive prefilled for a signed-in patient — `seedIdentity()` in core
// fills blanks from the profile. Consent is never prefilled.
const IDENTITY = [
  { name: 'fullName', label: 'Full name', type: 'text', required: true,
    autocomplete: 'name',
    hint: 'As it appears on your health card.' },
  { name: 'phone', label: 'Mobile number', type: 'tel', required: true,
    autocomplete: 'tel',
    hint: 'We\u2019ll message you here, and call this number if we need to.' },
  { name: 'dob', label: 'Date of birth', type: 'date', required: true,
    autocomplete: 'bday',
    hint: 'So we don\u2019t confuse you with another patient of the same name.' }
];

const identityStep = { title: 'About you', fields: IDENTITY };

const reviewStep = { title: 'Check and send', review: true, fields: [] };

// One notes field, two hints. On most forms it warns against health details,
// because docs/PIA.md §4 leans on that warning to keep those forms
// low-sensitivity. On the assessment the opposite is true — that form is *for*
// clinical detail — so it gets its own wording.
const notesField = hint => ({
  name: 'notes', label: 'Anything else we should know', type: 'textarea', hint
});

const NOTES_KEEP_CLEAR =
  'Optional. Please don\u2019t include symptoms or medication names here — a pharmacist will ask if they need them.';

/* ── Forms ────────────────────────────────────────────────────────────
   Three to five short pages each, always ending review → consent →
   submit. `done(values)` is the receipt a submitted card collapses into,
   and never repeats a clinical answer back.
   ─────────────────────────────────────────────────────────────────── */

const FORMS = {

  /* TRANSFER — the acquisition intent, built first per README. */
  transfer: {
    title: 'Transfer your prescriptions',
    blurb: 'We\u2019ll contact your current pharmacy and move your prescriptions over. You don\u2019t need to call them yourself.',
    submit: 'Send transfer request',
    steps: [
      identityStep,
      {
        title: 'Your current pharmacy',
        fields: [
          { name: 'fromPharmacy', label: 'Pharmacy name and location', type: 'text', required: true,
            hint: 'A name and a cross street or city is enough — "Rexall on Yonge" works.' }
        ]
      },
      {
        title: 'What to move',
        fields: [
          { name: 'scope', label: 'How much would you like transferred', type: 'radio', required: true,
            options: ['All of my prescriptions', 'Only some of them'],
            hint: 'If it\u2019s only some, a pharmacist will confirm which ones with you — you don\u2019t need to look anything up.' },
          notesField(NOTES_KEEP_CLEAR)
        ]
      },
      reviewStep
    ],
    done: () => ({
      title: 'Transfer request sent',
      note: 'We\u2019ll contact your current pharmacy and message you here once your prescriptions are with us. This usually takes 1\u20132 business days.'
    })
  },

  /* REFILL */
  refill: {
    title: 'Refill a prescription',
    blurb: 'Tell us which prescription and how you\u2019d like it, and we\u2019ll get it ready.',
    submit: 'Request refill',
    steps: [
      identityStep,
      {
        title: 'Which prescription',
        fields: [
          { name: 'rxNumbers', label: 'Prescription number', type: 'list', addLabel: 'Add another prescription',
            hint: 'On the label on your bottle or box. If you can\u2019t find it, leave this blank — we\u2019ll look it up from your name and date of birth.' }
        ]
      },
      {
        title: 'How would you like it',
        fields: [
          { name: 'delivery', label: 'Pickup or delivery', type: 'radio', required: true, options: DELIVERY },
          notesField(NOTES_KEEP_CLEAR)
        ]
      },
      reviewStep
    ],
    done: () => ({
      title: 'Refill requested',
      note: 'We\u2019ll message you here when it\u2019s ready. If there are no refills left on it, a pharmacist will contact your prescriber first.'
    })
  },

  /* RX_UPLOAD */
  upload: {
    title: 'Send us a prescription',
    blurb: 'Take a photo of the paper prescription your prescriber gave you, or upload a PDF.',
    submit: 'Send prescription',
    steps: [
      identityStep,
      {
        title: 'The prescription',
        fields: [
          { name: 'rxFiles', label: 'Photo or PDF of the prescription', type: 'file', required: true,
            accept: 'image/*,application/pdf',
            hint: 'Lay it flat, get all four corners in the frame, and check the writing is readable before you send it.' }
        ]
      },
      {
        title: 'A couple of details',
        fields: [
          { name: 'prescriber', label: 'Who prescribed it', type: 'text',
            hint: 'Optional. The prescriber\u2019s name, if you know it.' },
          notesField(NOTES_KEEP_CLEAR)
        ]
      },
      reviewStep
    ],
    done: () => ({
      title: 'Prescription sent',
      note: 'A pharmacist is reviewing it now and will message you here if anything is unclear, or when it\u2019s ready.'
    })
  },

  /* MINOR_AILMENT — the only high-sensitivity form here. docs/PIA.md §12 says
     adding it requires that assessment to be reworked before it goes live. */
  ailment: {
    title: 'Minor ailment assessment',
    blurb: 'An Ontario pharmacist can assess and prescribe for some conditions. Answer these and one will review it.',
    submit: 'Send assessment',
    steps: [
      identityStep,
      {
        title: 'What\u2019s going on',
        fields: [
          { name: 'condition', label: 'What would you like assessed', type: 'select', required: true,
            placeholder: 'Choose a condition', options: CONDITIONS }
        ]
      },
      {
        title: 'A bit more',
        fields: [
          { name: 'duration', label: 'How long has this been going on', type: 'select', required: true,
            placeholder: 'Choose one', options: DURATIONS },
          { name: 'priorTreatment', label: 'Have you tried anything for it', type: 'textarea',
            hint: 'Anything from the shelf, a previous prescription, or nothing yet — all useful.' },
          notesField('Optional. Anything else the pharmacist should know.')
        ]
      },
      {
        title: 'A few safety questions',
        // The one place this file is deliberately incomplete — see SCREENING above.
        fields: v => SCREENING[v.condition] || [SCREENING_NOT_LOADED]
      },
      reviewStep
    ],
    done: () => ({
      title: 'Assessment sent',
      note: 'A pharmacist will review it and message you here. If they can prescribe for this, they\u2019ll tell you what happens next.'
    })
  },

  /* PHARMACIST_CHAT — a callback request. A pharmacist answers this thread, so
     this is how a patient asks for one without the transcript carrying clinical
     detail they would rather discuss out loud. */
  callback: {
    title: 'Speak to a pharmacist',
    blurb: 'Tell us roughly what it\u2019s about and when suits you, and a pharmacist will get back to you.',
    submit: 'Request a call',
    steps: [
      identityStep,
      {
        title: 'What it\u2019s about',
        fields: [
          { name: 'topic', label: 'Roughly what would you like to discuss', type: 'select', required: true,
            placeholder: 'Choose one', options: TOPICS },
          { name: 'bestTime', label: 'When is a good time to reach you', type: 'radio', required: true,
            options: CALL_TIMES },
          notesField('Optional. You can save the detail for the call if you\u2019d rather.')
        ]
      },
      reviewStep
    ],
    done: () => ({
      title: 'Call requested',
      note: 'A pharmacist will reach out. If it\u2019s urgent, call the pharmacy directly rather than waiting for us here.'
    })
  }
};

/* ── Consent ──────────────────────────────────────────────────────────
   DRAFT — needs the privacy officer's sign-off before a real patient
   sees it.

   web/HANDOFF.md calls the consent block a verbatim fixed string, but the
   file carrying that string never landed in this repo, so there was no
   original to reproduce. Rather than invent wording, this is derived from
   the privacy notice already written in docs/privacy-documents.md §4 —
   what's collected, why, where it's stored, and that consent can be
   withdrawn without overriding records the pharmacy must keep.

   It names PHIPA. The trust badge under the composer names PIPEDA,
   because that string comes from `COUNTRY` in secure-chat.core.js. Both
   cannot be right. docs/PIA.md §2 says Medixly is a health information
   custodian under PHIPA and that PIPEDA is generally displaced for
   information a custodian holds — which is why this draft says PHIPA —
   but that section leaves the question open pending legal advice, and
   web/HANDOFF.md flags the same conflict. Resolve it in one place and
   change both together.

   Once signed off: do not paraphrase, shorten or improve it.
   ─────────────────────────────────────────────────────────────────── */

function consentBlock(pharmacyName, country) {
  const wrap = document.createElement('span');

  const lead = document.createElement('b');
  lead.textContent = 'I agree to the following.';
  wrap.append(lead);

  const body = document.createElement('span');
  body.textContent =
    ` I consent to ${pharmacyName} collecting the information in this form in order ` +
    'to carry out the request I have made and to contact me about it. I understand ' +
    `that ${pharmacyName} is a health information custodian under Ontario\u2019s Personal ` +
    'Health Information Protection Act, 2004, that my information is stored in Canada ' +
    'and encrypted in transit and at rest, and that every access to my record is ' +
    'logged. I understand that I may withdraw my consent at any time by contacting ' +
    'the pharmacy, that this may prevent a request already in progress from being ' +
    'completed, and that it does not require the pharmacy to delete records it is ' +
    'legally required to keep.';
  wrap.append(body);

  // Country decides the secure transport and the framework on the badge. Kept in
  // step with COUNTRY in secure-chat.core.js.
  if (country === 'USA') {
    const usa = document.createElement('span');
    usa.textContent =
      ' Information is transmitted via Paubox and handled in accordance with HIPAA.';
    wrap.append(usa);
  }

  return wrap;
}

const CONSENT_ERROR = 'Please tick the box above so we can act on your request.';

/* ── Vaccines — no form, on purpose ───────────────────────────────────
   `core` calls `vaccineBy()` for the `pool` and `days` field types, so the
   function has to exist. No form here uses those types, so it is never
   reached.

   There is no vaccine form because there is nowhere for a booking to go.
   `request_intent` in db/schema.sql has six values — REFILL, TRANSFER,
   RX_UPLOAD, MINOR_AILMENT, PHARMACIST_CHAT, OTC_ORDER — and vaccine
   booking is not one of them, so api/submit.ts rejects it as an unknown
   request type. Shipping the card first would mean a form that collects a
   patient's details and then fails on submit.

   What it needs: the pharmacy's decision that vaccines are a request
   type, then a migration adding the enum value and an entry in
   api/submit.ts's FORMS. The inventory itself belongs to the pharmacist
   dashboard rather than hardcoded here.

   Same reason there is no OTC form: OTC_ORDER exists server-side, but the
   storefront it should point at doesn't exist yet.
   ─────────────────────────────────────────────────────────────────── */

function vaccineBy() {
  console.warn(
    '[SecureChat] vaccineBy() was called, but no vaccine form ships — there is ' +
    'no VACCINE value in db/schema.sql\u2019s request_intent for a booking to land in.'
  );
  return null;
}
