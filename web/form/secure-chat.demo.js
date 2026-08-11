/* ════════════════════════════════════════════════════════════════════
   Demo wiring — replace everything below to go live.
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

/* ── Stub router ───────────────────────────────────────────────────────
   Stands in for `POST /api/chat` on a deploy preview, where there is no
   server to call. It matches keywords; it is not the classifier, and the copy
   below is not the agent's copy. The real intents, reply templates, emergency
   tripwire and two-strikes rule are all in `api/agent.ts`.

   It exists so the routing behaviour can be seen in a browser. It demonstrates
   nothing about how a real message gets classified. To go live, drop the
   `route` option so MedixlyAgent calls the endpoint, and delete this block.
   ─────────────────────────────────────────────────────────────────── */

console.warn(
  '[SecureChat] the agent is running against a keyword stub, not the classifier. ' +
  'Replies are placeholders. See api/agent.ts for the real routing.'
);

const STUB_ROUTES = [
  { intent: 'TRANSFER',        form: 'transfer', re: /transfer|switch(ing)? pharmac|move my (script|prescription)/i },
  { intent: 'REFILL',          form: 'refill',   re: /refill|running low|more of my|repeat/i },
  { intent: 'RX_UPLOAD',       form: 'upload',   re: /new prescription|upload|paper (rx|script)|from (my|the) doctor/i },
  { intent: 'MINOR_AILMENT',   form: 'ailment',  re: /rash|pink eye|cold sore|heartburn|uti|hives|sprain|acne/i },
  { intent: 'PHARMACIST_CHAT', form: null,       re: /pharmacist|interact|side effect|dose|dosing|missed/i },
  { intent: 'OTC_ORDER',       form: null,       re: /vitamin|tylenol|advil|supplement|order|buy/i }
];

// Deliberately short, only so the path is visible in a preview. The real list,
// and the reasoning for having one at all, are in api/agent.ts.
const STUB_EMERGENCY = /chest pain|can\u2019t breathe|can't breathe|trouble breathing|severe bleeding|suicidal/i;

const stubRoute = async (text, prior) => {
  await wait(600);

  if (STUB_EMERGENCY.test(text)) {
    return {
      intent: 'PHARMACIST_CHAT', form: null, escalate: true, emergency: true,
      reply: 'If this is an emergency, call 911 or go to your nearest emergency department now. Don\u2019t wait for a reply here.'
    };
  }

  const hit = STUB_ROUTES.find(r => r.re.test(text));

  // Second unclear turn in a row hands off — the same rule the agent applies.
  if (!hit) {
    return prior.at(-1) === 'UNCLEAR'
      ? { intent: 'UNCLEAR', form: null, escalate: true,
          reply: 'I\u2019m not sure I\u2019ve got this right, so I\u2019ve passed it to the team. Someone will reply here.' }
      : { intent: 'UNCLEAR', form: null, escalate: false,
          reply: 'Happy to help — is this about a prescription, a health concern, or an over-the-counter product?' };
  }

  return {
    intent: hit.intent,
    form: hit.form,
    escalate: !hit.form,
    reply: hit.form
      ? '[stub reply] Fill this in and we\u2019ll take it from there.'
      : '[stub reply] I\u2019ve flagged this for a pharmacist. They\u2019ll reply here.'
  };
};

/* ── Transport ─────────────────────────────────────────────────────────
   `send` is the agent's and is layered on by MedixlyAgent.transport() below;
   everything else is faked here.
   ─────────────────────────────────────────────────────────────────── */

const demoTransport = {
  submitForm(payload) {
    console.log('[SecureChat] form submitted', payload);
    const replies = {
      transfer: v => `Got it. We\u2019ve contacted ${v.prevPharmacyName || 'your previous pharmacy'} and will message you here once your prescription is ready. This usually takes 1\u20132 business days.`,
      refill:   v => `Thanks ${(v.fullName || '').split(' ')[0] || 'Maya'} — your refill is in the queue. We\u2019ll message you here when it\u2019s ready.`,
      upload:   () => 'Thanks — a pharmacist is reviewing your prescription now and will message you if anything is unclear.',
      vaccine:  v => v.clinicDay
        ? `You\u2019re booked for ${v.clinicDay}. Bring your health card and wear a short sleeve.`
        : 'Thanks — we\u2019ll be in touch by encrypted email as soon as we have news.',
      ailment:  () => 'Thanks — a pharmacist is reviewing your assessment and will message you here shortly.'
    };
    return new Promise(resolve => setTimeout(() => {
      resolve({ ok: true });
      setTimeout(() => chat.setTyping(true), 900);
      setTimeout(() => chat.receive({ text: replies[payload.form](payload.values) }), 2400);
    }, 900));
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

// Drop `route` to send messages to the real endpoint instead of the stub.
const transport = MedixlyAgent.transport(demoTransport, { route: stubRoute });

// Read receipts belong to `subscribe` in production — they mean a pharmacist
// opened the thread, which is not something the agent can know. Faked here so
// the sending → delivered → read run is still visible on a preview.
const agentSend = transport.send;
transport.send = async msg => {
  const receipt = await agentSend(msg);
  setTimeout(() => chat.setStatus(msg.id, 'read'), 1200);
  return receipt;
};

const chat = new SecureChat(document.getElementById('chat'), {
  pharmacyName: 'Medixly',
  presence: 'Pharmacist on duty · replies within 2 hours',
  country: 'Canada',
  history: seed,
  transport,
  onBack: () => console.log('[SecureChat] back'),
  onCall: () => console.log('[SecureChat] call [Phone Number]')
});

// The agent answers into the thread, so it needs the instance — and the chat
// needed the transport first.
transport.agent.attach(chat);

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
  phone: '+1 555 0100',
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
   Two things change. Point the agent at the endpoint by dropping `route`:

     const transport = MedixlyAgent.transport(realTransport);

   and replace the rest of the transport with the real one:

   const realTransport = {
     subscribe(onMessage) {                  // SSE, WebSocket, or polling
       new EventSource('/api/chat/stream')
         .addEventListener('message', e => onMessage(JSON.parse(e.data)));
     },
     upload(file) { … },                     // returns { url } for attachments
     submitForm(payload) { … }               // POST /api/submit
   };

   `send` stays the agent's. `POST /api/chat` is both the delivery receipt and
   the reply: a 200 means the pharmacy has the message and the body says what
   to answer with. A throw makes the bubble offer "tap to retry", so keep
   throwing on network failure.

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
