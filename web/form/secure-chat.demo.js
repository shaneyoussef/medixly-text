/* ════════════════════════════════════════════════════════════════════
   Demo wiring — replace everything below to go live.

   The agent routes and a pharmacist answers whatever it hands over. It
   never suggests a product for a symptom — see docs/AGENT.md.
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

/* ── Stub shop ──────────────────────────────────────────
   Stands in for `/api/shop` on a deploy preview. The products are real —
   copied from the InstaCare catalogue — so the cards show true titles,
   CAD prices and CDN images, but the matching here is a local substring
   pass, not the proxy, and there is no allowlist behind it.

   Two things this therefore proves nothing about: that only curated
   products are reachable, and that a cart Shopify would accept comes
   back. Both live in api/shop.ts.
   ───────────────────────────────────────────────────── */

console.warn(
  '[SecureChat] the shop is running against a stub, not /api/shop. ' +
  'No allowlist is enforced and no Shopify cart is created.'
);

const CDN = 'https://cdn.shopify.com/s/files/1/0958/7798/8645/files/';

const STUB_PRODUCTS = [
  { variantId: 'gid://shopify/ProductVariant/51931288273189', title: 'Claritin Allergy 24-Hour, 10 Tablets',
    vendor: 'Claritin', productType: 'Allergy and Sinus', price: '11.49', currency: 'CAD',
    image: CDN + '056219981142-600x600.jpg?v=1769271765', available: true },
  { variantId: 'gid://shopify/ProductVariant/51931288338725', title: 'Claritin Allergy 24-Hour, 20 Tablets',
    vendor: 'Claritin', productType: 'Allergy and Sinus', price: '22.99', currency: 'CAD',
    image: CDN + '056219981210-600x600.jpg?v=1769271767', available: true },
  { variantId: 'gid://shopify/ProductVariant/51931287683365', title: 'Allegra Allergies 24-Hour Relief, 12 Tablets',
    vendor: 'Allegra', productType: 'Allergy and Sinus', price: '14.99', currency: 'CAD',
    image: CDN + '065914104398-600x600.jpg?v=1769271757', available: true },
  { variantId: 'gid://shopify/ProductVariant/51931287453989', title: 'health One Loratadine Allergy Remedy 10 mg - 12 Tablets',
    vendor: 'health One', productType: 'Allergy and Sinus', price: '10.99', currency: 'CAD',
    image: CDN + '00066000020820_A1C1-600x600.jpg?v=1769271751', available: true },
  { variantId: 'gid://shopify/ProductVariant/51931287879973', title: 'Breathe Right Nasal Strips, Extra Strength - 8 Strips',
    vendor: 'Breathe', productType: 'Allergy and Sinus', price: '10.49', currency: 'CAD',
    image: CDN + 'breathe-right-nasal-strips-extra-strength-tan-600x600.jpg?v=1769271761', available: true },
  { variantId: 'gid://shopify/ProductVariant/51931287585061', title: 'Aerius Desloratadine Tablets USP 5 mg - 40 Tablets',
    vendor: 'Aerius', productType: 'Allergy and Sinus', price: '44.99', currency: 'CAD',
    image: null, available: false }
];

const stubShop = {
  async search(query) {
    await wait(500);
    // Mirrors the stopword pass in api/shop.ts, without which a whole sentence
    // like "do you have claritin" matches nothing.
    const NOISE = new Set(['do','you','have','any','a','an','the','i','im','need',
      'looking','for','some','please','get','buy','sell','carry','is','it','my',
      'what','anything','something','hi','hello','order','stock']);
    const terms = String(query || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(t => t && !NOISE.has(t));
    const products = STUB_PRODUCTS.filter(p => {
      const hay = `${p.title} ${p.vendor} ${p.productType}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    });
    return { products, total: products.length };
  },
  async cart(lines) {
    await wait(700);
    console.log('[SecureChat] POST /api/shop/cart', { lines });
    // A cart permalink is a real Shopify URL and needs no API call, so the
    // fallback path can be exercised without credentials.
    const permalink = lines
      .map(l => `${l.variantId.split('/').pop()}:${l.quantity}`)
      .join(',');
    return {
      id: 'gid://shopify/Cart/stub',
      checkoutUrl: `https://f1u1zc-8t.myshopify.com/cart/${permalink}`,
      totalQuantity: lines.reduce((n, l) => n + l.quantity, 0)
    };
  }
};

const shop = new MedixlyShop({ search: q => stubShop.search(q), cart: l => stubShop.cart(l) });

/* ── Stub router ──────────────────────────────────────────
   Stands in for `POST /api/chat`. Keyword matching, not the classifier,
   and the reply copy here is placeholder — the real intents, templates,
   emergency tripwire, two-strikes rule and refusal boundary are all in
   api/agent.ts.

   It does mirror one thing faithfully, because it is the rule most worth
   seeing work in a browser: a shopping message with a symptom in it gets
   a pharmacist, not a shelf.
   ─────────────────────────────────────────────────────── */

console.warn(
  '[SecureChat] the agent is running against a keyword stub, not the classifier. ' +
  'Replies are placeholders. See api/agent.ts for the real routing.'
);

const STUB_EMERGENCY = /chest pain|can\u2019t breathe|can't breathe|trouble breathing|severe bleeding|suicidal/i;

// Stands in for the classifier's contains_health_details flag, which is what
// the real boundary keys on.
const STUB_SYMPTOM = /itchy|itching|rash|sore|pain|ache|sneez|congest|runny|watery|swollen|burning|infection|fever/i;

const STUB_ROUTES = [
  { intent: 'TRANSFER',        form: 'transfer', re: /transfer|switch(ing)? pharmac|move my (script|prescription)/i },
  { intent: 'REFILL',          form: 'refill',   re: /refill|running low|more of my|repeat/i },
  { intent: 'RX_UPLOAD',       form: 'upload',   re: /new prescription|upload|paper (rx|script)|from (my|the) doctor/i },
  { intent: 'MINOR_AILMENT',   form: 'ailment',  re: /pink eye|cold sore|heartburn|uti|hives|sprain|acne/i },
  { intent: 'PHARMACIST_CHAT', form: 'callback', re: /pharmacist|interact|side effect|dose|dosing|missed/i }
];

const STUB_SHOPPING = /claritin|allegra|aerius|loratadine|nasal strip|antihistamine|allergy|buy|order|do you (have|sell|carry)|shop|what (can|should) i take|something for my|recommend/i;

const stubRoute = async (text, prior) => {
  await wait(600);

  if (STUB_EMERGENCY.test(text)) {
    return {
      intent: 'PHARMACIST_CHAT', form: null, shopQuery: null, escalate: true, emergency: true,
      reply: 'If this is an emergency, call 911 or go to your nearest emergency department now. Don\u2019t wait for a reply here.'
    };
  }

  if (STUB_SHOPPING.test(text)) {
    // The refusal boundary. A symptom turns a shopping request into a
    // clinical one, and no product is offered.
    if (STUB_SYMPTOM.test(text)) {
      return {
        intent: 'OTC_ORDER', form: 'callback', shopQuery: null, escalate: true,
        reply: 'I\u2019d rather a pharmacist answered that than have me point you at a shelf. Tell them what\u2019s going on and they\u2019ll say what will actually help.'
      };
    }
    return {
      intent: 'OTC_ORDER', form: null, shopQuery: text, escalate: false,
      reply: 'Here\u2019s what we have on the shelf. A pharmacist checks every order before it goes out.'
    };
  }

  const hit = STUB_ROUTES.find(r => r.re.test(text));
  if (!hit) {
    return prior.at(-1) === 'UNCLEAR'
      ? { intent: 'UNCLEAR', form: null, shopQuery: null, escalate: true,
          reply: 'I\u2019m not sure I\u2019ve got this right, so I\u2019ve passed it to the team. Someone will reply here.' }
      : { intent: 'UNCLEAR', form: null, shopQuery: null, escalate: false,
          reply: 'Happy to help \u2014 is this about a prescription, a health concern, or something from the shelf?' };
  }

  return {
    intent: hit.intent, form: hit.form, shopQuery: null, escalate: !hit.form,
    reply: '[stub reply] Fill this in and we\u2019ll take it from there.'
  };
};

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

// Drop `route` to send messages to the real endpoint instead of the stub.
// Read receipts mean a person opened the thread, which the agent can't know —
// faked so the sending \u2192 delivered \u2192 read run is visible on a preview.
const transport = MedixlyAgent.transport(demoTransport, { route: stubRoute, shop });
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
  shop,
  onBack: () => console.log('[SecureChat] back'),
  onCall: () => console.log('[SecureChat] call [Phone Number]')
});

// Both answer into the thread, so both need the instance — and the chat
// needed the transport first.
shop.attach(chat);
transport.agent.attach(chat, shop);

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
