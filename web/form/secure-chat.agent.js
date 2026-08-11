/* ════════════════════════════════════════════════════════════════════
   MedixlyAgent — the chat's reply logic, on the browser side.

   `SecureChat` is a view layer: it sends what you type and renders what
   arrives. This is the half that decides what arrives. It posts each
   outgoing message to `POST /api/chat`, and applies the decision that comes
   back — a reply in the thread, and where relevant a form card.

   It owns `send` only. Attachments and form submission belong to the rest of
   the transport; `MedixlyAgent.transport(base)` layers this over one.

   No classification happens here. The intent taxonomy, the reply copy, the
   emergency tripwire and the two-strikes rule all live in `api/agent.ts`,
   server-side, because that's where the API key is and because SMS runs the
   same code. This file is a courier for the decision, not a second opinion
   on it — keep it that way, or the two channels will drift.
   ════════════════════════════════════════════════════════════════════ */

class MedixlyAgent {
  /**
   * @param {object} opts
   *   endpoint  — defaults to '/api/chat'
   *   chat      — the SecureChat instance, or set it later with attach()
   *   route     — override the network call: async (text, prior) => decision.
   *               The demo passes a stub here; nothing else should.
   *   thinking  — ms before the typing indicator appears
   *   pace      — ms the typing indicator stays up before the reply lands
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? '/api/chat';
    this.chat = opts.chat ?? null;
    this.shop = opts.shop ?? null;
    this.route = opts.route ?? null;
    this.thinking = opts.thinking ?? 500;
    this.pace = opts.pace ?? 1400;

    // Intent labels only, never message text — the same shape `api/chat.ts`
    // expects, and it carries no health information, so it can sit in memory
    // here without becoming something that has to be purged.
    this.prior = [];
  }

  attach(chat, shop) {
    this.chat = chat;
    if (shop) this.shop = shop;
    return this;
  }

  /** Wraps a base transport so `send` runs through the agent. */
  static transport(base, opts = {}) {
    const agent = new MedixlyAgent(opts);
    return { ...base, agent, send: msg => agent.send(msg) };
  }

  /**
   * Transport `send`. The endpoint is both the delivery receipt and the reply:
   * a 200 means the pharmacy has the message, and the body says what to answer
   * with. A throw here is what makes the bubble offer "tap to retry", so
   * network failures must keep throwing.
   */
  async send(msg) {
    const decision = await this.decide(msg.text || '');
    const receipt = { status: 'delivered', ts: Date.now() };

    // Answer after the receipt resolves, so the bubble settles first.
    this.answer(decision);
    return receipt;
  }

  async decide(text) {
    if (this.route) return this.route(text, [...this.prior]);

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, channel: 'web', prior: this.prior })
    });
    if (!res.ok) throw new Error(`chat endpoint ${res.status}`);
    return res.json();
  }

  /** Puts one decision into the thread. */
  answer(decision) {
    if (!decision || !this.chat) return;
    if (decision.intent) this.prior.push(decision.intent);

    // An emergency reply waits for nothing. No typing indicator, no pause for
    // realism — a delay on "call 911" is indefensible.
    if (decision.emergency) {
      this.chat.setTyping(false);
      this.chat.receive({ text: decision.reply });
      return;
    }

    setTimeout(() => this.chat.setTyping(true), this.thinking);
    setTimeout(() => {
      this.chat.receive({ text: decision.reply });
      if (decision.form) this.chat.requestForm(decision.form);
      // A shop query only ever arrives for a product request the classifier
      // found no health details in. The refusal boundary is enforced in
      // api/agent.ts, not here — this end just runs what it's given.
      if (decision.shopQuery) {
        this.shop?.search(decision.shopQuery)
          .catch(err => console.error('[MedixlyAgent] product search failed', err));
      }
    }, this.thinking + this.pace);
  }

  /** Forgets the intent history — call on sign-out. */
  reset() { this.prior = []; }
}

/* ── Wiring ───────────────────────────────────────────────────────────
   const transport = MedixlyAgent.transport(
     { upload, submitForm, subscribe },      // the rest of the transport
     { chat: null }                          // attached below
   );
   const chat = new SecureChat(el, { transport, … });
   transport.agent.attach(chat);

   `attach` after construction because the agent needs the instance it is
   answering into, and `SecureChat` needs the transport to be built first.

   Still missing on the server side, and both are in web/HANDOFF.md task 6:
   `/api/chat` classifies a message but does not store the thread, so nothing
   here survives a reload; and `escalate` comes back in the response and has
   nowhere to go — see the footer of `api/chat.ts`.
─────────────────────────────────────────────────────────────────────── */
