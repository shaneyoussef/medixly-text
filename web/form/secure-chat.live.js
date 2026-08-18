/* ══════════════════════════════════════════════════════════════════════
   Medixly · live transport — the patient half of the secure channel.

   The demo stub in secure-chat.demo.js answers in the browser and proves
   nothing. This talks to /functions/v1/chat, which is the same thread the
   pharmacist is looking at in the queue dashboard.

   It takes over only when the URL carries `#t=<token>` (or a legacy `?t=`),
   which is the link a pharmacist sends. That token *is* the credential — there
   is no account and no password behind it — which is why the server scopes it
   to one request and expires it, and why this file never writes it anywhere.
   It stays in the address bar and nowhere else: no localStorage, no cookie,
   nothing left on a shared phone after the tab closes.

   The token lives in the hash (`#t=`), not the query string, so it is not
   sent to Netlify or to anyone as a Referer. `?t=` links still work and are
   rewritten to the hash on load.
   ═══════════════════════════════════════════════════════════════════ */

const CHAT_API = 'https://vejzchchrliqrlzlepkc.supabase.co/functions/v1/chat';

/** Polling, not realtime — see the note in web/queue/index.html. */
const POLL_MS = 8000;

function readLiveToken() {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
  const fromQuery = new URLSearchParams(location.search).get('t');
  const token = fromHash || fromQuery;
  // Pull a legacy query token out of the address bar so later navigations,
  // screenshots of the URL, and Referer headers do not keep carrying it.
  if (token && fromQuery && !fromHash) {
    const url = new URL(location.href);
    url.searchParams.delete('t');
    url.hash = 't=' + encodeURIComponent(token);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return token;
}

/** Read once. Not stored, not copied, not logged. */
const LIVE_TOKEN = readLiveToken();

class MedixlyLive {
  /**
   * @param {object} opts
   *   token     the chat token from the URL
   *   onError(message)   surfaced to the patient
   */
  constructor(opts) {
    this.token = opts.token;
    this.onError = opts.onError || (() => {});
    this.chat = null;
    this.seen = new Set();      // server ids already on screen
    this.timer = null;
  }

  url(extra = '') { return `${CHAT_API}?t=${encodeURIComponent(this.token)}${extra}`; }

  async call(opts = {}) {
    const res = await fetch(this.url(), {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  /* ── The SecureChat transport contract ───────────────────────────── */

  /**
   * Sends, and resolves with the delivery receipt. SecureChat marks the
   * bubble failed if this throws, and offers a retry — so a dropped
   * connection loses a tick, not the patient's message.
   */
  async send(msg) {
    const res = await this.call({ method: 'POST', body: JSON.stringify({ body: msg.text }) });
    if (res.id) this.seen.add(res.id);
    // Pull straight away rather than waiting for the next tick: a pharmacist
    // may already have replied while the patient was typing.
    this.tick();
    return { status: 'delivered', ts: res.created_at ? new Date(res.created_at).getTime() : Date.now() };
  }

  /** SecureChat hands us a callback for inbound messages. */
  subscribe(fn) { this.inbound = fn; }

  /* ── Lifecycle ───────────────────────────────────────────────────── */

  /** Loads the thread, then keeps it current. Returns the opening state. */
  async start(chat) {
    this.chat = chat;
    const thread = await this.call();

    // Everything already on the server, in order, without animating a history
    // the patient has read before.
    chat.load((thread.messages || []).map(m => {
      this.seen.add(m.id);
      return {
        id: m.id,
        from: m.sender === 'patient' ? 'me' : 'them',
        text: m.body,
        ts: new Date(m.created_at).getTime(),
        status: 'read',
      };
    }));

    this.watch();
    return thread;
  }

  watch() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), POLL_MS);
    // A phone that has been in a pocket is the common case, not the rare one.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.tick();
    });
  }

  async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      const thread = await this.call();
      for (const m of thread.messages || []) {
        if (this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        // Only the pharmacy's side arrives this way. Our own messages are
        // already on screen from send(), and re-adding them would double them.
        if (m.sender !== 'patient') {
          this.inbound?.({ text: m.body, ts: new Date(m.created_at).getTime() });
        }
      }
    } catch (err) {
      // A failed poll is not worth interrupting anyone over — the next one is
      // eight seconds away. An expired or revoked link is, because nothing
      // will work again until the pharmacy sends a new one.
      if (err.status === 410 || err.status === 404) {
        clearInterval(this.timer);
        this.onError(err.message);
      }
    } finally {
      this.polling = false;
    }
  }
}
