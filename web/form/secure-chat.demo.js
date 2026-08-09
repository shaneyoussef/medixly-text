/* ════════════════════════════════════════════════════════════════════
   Demo wiring — replace everything below to go live.
   ════════════════════════════════════════════════════════════════════ */

const at = (daysAgo, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const seed = [
  { from: 'them', text: 'Hi Maya — your refill for Metformin 500 mg is ready for pickup. We\u2019re open until 8pm today.', ts: at(1, 14, 14) },
  { from: 'me',   text: 'Thanks! Could I pick it up tomorrow morning instead?', ts: at(1, 14, 31) },
  { from: 'them', text: 'Of course. We\u2019ll hold it on the shelf for seven days.', ts: at(1, 14, 35) },
  { from: 'me',   text: 'One more thing — should I keep taking it with food?', ts: at(0, 9, 2) },
  { from: 'them', text: 'Yes. Take it with your largest meal to reduce stomach upset. If you miss a dose, skip it and take the next one at the usual time — don\u2019t double up.', ts: at(0, 9, 10) }
];

// A fake transport that mimics delivery receipts and a pharmacist reply.
const demoTransport = {
  send(msg) {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({ status: 'delivered', ts: Date.now() });
        setTimeout(() => chat.setStatus(msg.id, 'read'), 1200);

        // A pharmacist reading "transfer" would push the form into the thread.
        if (/transfer/i.test(msg.text || '')) {
          setTimeout(() => chat.setTyping(true), 1600);
          setTimeout(() => {
            chat.receive({ text: 'Happy to help with that. Fill this in and we\u2019ll take it from there.' });
            chat.requestForm('transfer');
          }, 3000);
          return;
        }

        setTimeout(() => chat.setTyping(true), 1800);
        setTimeout(() => chat.receive({
          text: 'Thanks Maya — a pharmacist has your message and will reply shortly. If this is urgent, call us at [Phone Number].'
        }), 3600);
      }, 700);
    });
  },
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

const chat = new SecureChat(document.getElementById('chat'), {
  pharmacyName: 'Old Park Pharmacy',
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

const wait = (ms, value) => new Promise(r => setTimeout(() => r(value), ms));

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
  pharmacyName: 'Old Park Pharmacy',
  country: 'Canada',
  onSession: profile => console.log('[auth] session', profile)
});

/* ── Going live ───────────────────────────────────────────────────────
   Swap `demoTransport` for the real one. Nothing else changes.

   const transport = {
     async send(msg) {                       // msg: {id, text, ts, files, blobs}
       const r = await fetch('/api/chat/send', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ id: msg.id, text: msg.text, files: msg.files })
       });
       if (!r.ok) throw new Error(r.statusText);  // → bubble shows "Not sent — tap to retry"
       return r.json();                           // → { status: 'delivered', ts }
     },
     subscribe(onMessage) {                  // SSE, WebSocket, or polling
       new EventSource('/api/chat/stream')
         .addEventListener('message', e => onMessage(JSON.parse(e.data)));
     },
     upload(file) { … }                      // returns { url } for attachments
   };

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
