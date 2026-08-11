/* ════════════════════════════════════════════════════════════════════
   Demo wiring — replace everything below to go live.

   A pharmacist answers this thread. There is no agent in this page: the
   rail and the form cards are how a request starts, and a message is just
   a message waiting for a person. `api/agent.ts` and
   `secure-chat.agent.js` exist and are not loaded — see docs/AGENT.md.
   ════════════════════════════════════════════════════════════════════ */

const at = (daysAgo, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const wait = (ms, value) => new Promise(r => setTimeout(() => r(value), ms));

const seed = [
  { from: 'them', text: 'Hi Maya — your refill for Metformin 500 mg is ready for pickup. We\u2019re open until 8pm today.', ts: at(1, 14, 14) },
  { from: 'me',   text: 'Thanks! Could I pick it up tomorrow morning instead?', ts: at(1, 14, 31) },
  { from: 'them', text: 'Of course. We\u2019ll hold it on the shelf for seven days.', ts: at(1, 14, 35) },
  { from: 'me',   text: 'One more thing — should I keep taking it with food?', ts: at(0, 9, 2) },
  { from: 'them', text: 'Yes. Take it with your largest meal to reduce stomach upset. If you miss a dose, skip it and take the next one at the usual time — don\u2019t double up.', ts: at(0, 9, 10) }
];

/* ── The submission mapper ─────────────────────────────────────────────
   Form values in, `POST /api/submit` body out. This is the seam the client
   and the server meet at, and it is not cosmetic: `api/submit.ts`
   whitelists per intent and drops anything it doesn't recognise, so a
   field that isn't mapped here is a field that silently never gets stored.

   Field names are the client's; keys are the server's. Keep both columns
   in step with the `FORMS` table in api/submit.ts.
   ─────────────────────────────────────────────────────────────────── */

const SUBMISSIONS = {
  transfer: {
    intent: 'TRANSFER',
    payload: v => ({ from_pharmacy: v.fromPharmacy, scope: v.scope, notes: v.notes })
  },
  refill: {
    intent: 'REFILL',
    payload: v => ({ rx_numbers: entries(v.rxNumbers), pickup_or_delivery: v.delivery, notes: v.notes })
  },
  upload: {
    intent: 'RX_UPLOAD',
    // file_path comes from the upload, not from the form — see toSubmission().
    payload: (v, paths) => ({ file_path: paths[0], prescriber: v.prescriber, notes: v.notes })
  },
  ailment: {
    intent: 'MINOR_AILMENT',
    payload: v => ({ condition: v.condition, duration: v.duration, prior_treatment: v.priorTreatment, notes: v.notes })
  },
  callback: {
    intent: 'PHARMACIST_CHAT',
    payload: v => ({ topic: v.topic, best_time: v.bestTime, notes: v.notes })
  }
};

/** A `list` field always holds at least one empty string. Drop the blanks. */
const entries = list => (list || []).map(s => String(s).trim()).filter(Boolean);

/** Drops empty values, the same way api/submit.ts does before storing. */
const prune = obj => Object.fromEntries(
  Object.entries(obj).filter(([, v]) =>
    v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
);

function toSubmission(payload, paths = []) {
  const spec = SUBMISSIONS[payload.form];
  if (!spec) throw new Error(`no submission mapping for form "${payload.form}"`);
  const v = payload.values;

  return {
    intent: spec.intent,
    channel: 'web',
    patient: {
      // tenDigits() lives in core, next to the field validation that uses it.
      name: String(v.fullName || '').trim(),
      phone: tenDigits(v.phone) || '',
      dob: v.dob || null
    },
    payload: prune(spec.payload(v, paths)),
    // Each submission carries its own consent timestamp. Never reused, never
    // prefilled — see web/HANDOFF.md task 4.
    consent: {
      given: payload.consent === true,
      at: payload.consentAt,
      method: 'checkbox'
    }
  };
}

/* ── Transport ─────────────────────────────────────────────────────────
   Faked here. `send` resolves a receipt and a pharmacist answers a while
   later; `submitForm` maps and logs instead of posting.
   ─────────────────────────────────────────────────────────────────── */

const demoTransport = {
  send(msg) {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({ status: 'delivered', ts: Date.now() });

        // Read receipts mean a person opened the thread. Faked so the
        // sending → delivered → read run is visible on a preview.
        setTimeout(() => chat.setStatus(msg.id, 'read'), 1200);

        setTimeout(() => chat.setTyping(true), 1800);
        setTimeout(() => chat.receive({
          text: 'Thanks Maya — a pharmacist has your message and will reply shortly. If this is urgent, call us at [Phone Number].'
        }), 3600);
      }, 700);
    });
  },

  async submitForm(payload) {
    // Attachments are stored first, so file_path points at something.
    const paths = [];
    for (const file of payload.blobs || []) {
      const { url } = await demoTransport.upload(file);
      paths.push(url);
    }

    const body = toSubmission(payload, paths);
    console.log('[SecureChat] POST /api/submit', body);

    await wait(900);
    setTimeout(() => chat.setTyping(true), 900);
    setTimeout(() => chat.receive({ text: FORMS[payload.form].done(payload.values).note }), 2400);
    return { reference: 'DEMO-00000', status: 'received' };
  },

  subscribe() {},

  // Fakes a chunked upload so the progress bar is exercised.
  upload(file, onProgress) {
    return new Promise(resolve => {
      let pct = 0;
      const step = setInterval(() => {
        pct = Math.min(100, pct + 12 + Math.random() * 18);
        onProgress?.(pct);
        if (pct >= 100) { clearInterval(step); resolve({ url: URL.createObjectURL(file) }); }
      }, 180);
    });
  }
};

const chat = new SecureChat(document.getElementById('chat'), {
  pharmacyName: 'Medixly',
  presence: 'Pharmacist on duty · replies within 2 hours',
  country: 'Canada',
  history: seed,
  transport: demoTransport,
  onBack: () => console.log('[SecureChat] back'),
  onCall: () => console.log('[SecureChat] call [Phone Number]')
});

/* ── Auth gate ─────────────────────────────────────────────────────────
   A stub `auth` matching the contract at the bottom of secure-chat.auth.js.

   Every call resolves in the browser. Nothing is verified, no token is
   checked, no session survives a reload, and any six digits are accepted.
   This exercises the screens — it demonstrates nothing about auth. The six
   numbered rules in that file's footer are all server-side work.
   ─────────────────────────────────────────────────────────────────── */

const demoPatient = {
  id: 'demo-0001',
  name: 'Maya Halloran',
  email: 'maya@example.com',
  phone: '416 555 0100',
  dob: '1988-04-12',
  healthCard: '1234-567-890-AB',
  hasPasskey: false,
  guest: false
};

const demoAuth = {
  // null so every reload lands on sign-in — that's the screen under review.
  // Return { profile } instead to boot straight into the chat.
  currentSession: () => wait(400, null),

  // Google proves control of an address, not that the person is this patient,
  // so both it and a verified code route to the link screen.
  googleSignIn: () => wait(700, { needsLink: true }),
  requestCode: ({ to }) => { console.log('[auth] code sent to', to); return wait(700, { ok: true }); },
  verifyCode: ({ code }) => code === '000000'
    ? Promise.reject(new Error('rejected code, for testing the error path'))
    : wait(700, { needsLink: true }),

  linkPatient: ({ healthCard, dob }) => wait(900, { profile: { ...demoPatient, healthCard, dob } }),

  passkeyRegister: () => wait(600, { ok: true }),
  passkeyAuth: () => wait(600, { profile: { ...demoPatient, hasPasskey: true } }),
  signOut: () => wait(300, { ok: true })
};

new AuthGate(document.getElementById('chat'), {
  auth: demoAuth,
  chat,
  pharmacyName: 'Medixly',
  country: 'Canada',
  onSession: profile => console.log('[auth] session', profile)
});

/* ── Going live ───────────────────────────────────────────────────────
   Keep `toSubmission()` — it is the real mapping, not demo scaffolding —
   and replace the transport around it:

   const transport = {
     async send(msg) {                       // msg: {id, text, ts, files}
       const r = await fetch('/api/chat/send', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ id: msg.id, text: msg.text, files: msg.files })
       });
       if (!r.ok) throw new Error(r.statusText);  // → "Not sent — tap to retry"
       return r.json();                           // → { status: 'delivered', ts }
     },
     async submitForm(payload) {
       const paths = [];
       for (const file of payload.blobs || []) {
         const { path } = await this.upload(file);
         paths.push(path);
       }
       const r = await fetch('/api/submit', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ ...toSubmission(payload, paths), token })
       });
       if (!r.ok) throw new Error((await r.json()).error);
       return r.json();                           // → { reference, status }
     },
     subscribe(onMessage) {                  // SSE, WebSocket, or polling
       new EventSource('/api/chat/stream')
         .addEventListener('message', e => onMessage(JSON.parse(e.data)));
     },
     upload(file) { … }                      // returns { path } for attachments
   };

   `upload` must return a storage path, not a blob URL. `api/submit.ts`
   requires `file_path` on RX_UPLOAD and stores whatever it is given, so a
   `blob:` URL would be written to the record and be dead on arrival. The
   `URL.createObjectURL` stub above must not ship.

   Other hooks:
     chat.setPresence('Closed — we reply at 9am', 'away');
     chat.setTyping(true);
     chat.receive({ text: 'Your prescription is ready.' });
     chat.setStatus(id, 'read');

   Compliance note: message bodies must travel over the pharmacy's configured
   secure platform (Canada → Hushmail for Healthcare / PIPEDA, USA → Paubox /
   HIPAA). Pass `country` to keep the trust badge in sync, and log a consent
   timestamp when the patient first opens a thread.
─────────────────────────────────────────────────────────────────────── */
