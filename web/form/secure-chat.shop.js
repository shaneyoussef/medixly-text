/* ════════════════════════════════════════════════════════════════════
   MedixlyShop — over-the-counter ordering inside the thread.

   Three jobs: search the products a patient may buy, build a Shopify cart,
   and get them through checkout without leaving this page.

   ── The shape of this, and why ────────────────────────────────────
   The products come *into* the chat. The chat does not go into the
   Shopify storefront, and that is a privacy decision rather than a
   preference. A storefront page runs theme JavaScript, installed apps and
   whatever marketing pixels are configured; mounting a patient's health
   conversation in that document would put those scripts in the same DOM
   as it. Here, the only Shopify traffic is JSON through our own proxy
   plus images from their CDN — no Shopify script on the page at all.

   Everything goes through `/api/shop`, never straight to Shopify. The
   proxy pins the query to one curated collection, which is what makes the
   list of what a patient can buy unforgeable from the browser. See
   docs/SHOP.md.
   ════════════════════════════════════════════════════════════════════ */

class MedixlyShop {
  /**
   * @param {object} opts
   *   endpoint — defaults to '/api/shop'
   *   chat     — the SecureChat instance, or attach() later
   *   search   — override the network call: async (query) => { products }
   *   cart     — override the cart call:   async (lines) => { checkoutUrl, … }
   *   onOrder  — called with the completed order once checkout finishes
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? '/api/shop';
    this.chat = opts.chat ?? null;
    this._search = opts.search ?? null;
    this._cart = opts.cart ?? null;
    this.onOrder = opts.onOrder ?? null;
  }

  attach(chat) { this.chat = chat; return this; }

  /* ── Search ──────────────────────────────────────────────────── */

  /**
   * Looks up products and drops the results into the thread.
   *
   * `query` is a product, brand or category — "claritin", "nasal strips".
   * It is never a symptom. Nothing in this file maps a complaint to a
   * product, because that is clinical advice and belongs to a pharmacist;
   * the agent stops symptom messages before they reach here, and
   * `api/agent.ts` carries the test that proves it.
   */
  async search(query) {
    const { products } = await this.fetchProducts(query);
    this.chat?.showProducts(query, products);
    return products;
  }

  async fetchProducts(query) {
    if (this._search) return this._search(query);

    const url = `${this.endpoint}/products?q=${encodeURIComponent(query || '')}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`shop products ${res.status}`);
    return res.json();
  }

  /* ── Checkout ────────────────────────────────────────────────── */

  /**
   * Cart, then checkout, without leaving the page.
   *
   * Two paths. Shopify's Checkout Kit renders their real checkout inside
   * this surface over the Embedded Checkout Protocol — payment, tax and
   * order creation all stay with Shopify, which is also why no card
   * details ever touch this system. If the SDK isn't present, the same
   * `checkoutUrl` opens in a new tab.
   *
   * The fallback is not defensive padding: Checkout Kit's web SDK is
   * pre-general-availability at the time of writing, so the hosted tab is
   * the path that is guaranteed to work. Never hand-roll an iframe around
   * `checkoutUrl` instead — framing checkout is blocked, and ECP is the
   * supported way in.
   */
  async checkout(lines) {
    if (!lines?.length) return null;

    const cart = await this.createCart(lines);
    if (!cart?.checkoutUrl) throw new Error('cart has no checkoutUrl');

    // The health transcript is not for a payment surface. AuthGate already
    // knows how to hide it; borrow that rather than inventing a second way.
    this.chat?.root.classList.add('is-checkout');

    try {
      const kit = await this.loadKit();
      if (kit) return await this.present(kit, cart);
      return this.openHosted(cart);
    } catch (err) {
      console.warn('[MedixlyShop] embedded checkout unavailable, opening hosted', err);
      return this.openHosted(cart);
    }
  }

  async createCart(lines) {
    if (this._cart) return this._cart(lines);

    const res = await fetch(`${this.endpoint}/cart`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines })
      // No note, no attributes, no tags. A Shopify order records what was
      // bought, never why.
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `shop cart ${res.status}`);
    }
    return res.json();
  }

  /**
   * `@shopify/checkout-kit`, if the page has it. Returns null rather than
   * throwing so the hosted path stays the quiet default.
   */
  async loadKit() {
    const kit = window.ShopifyCheckoutKit || window.checkoutKit;
    return kit && typeof kit.present === 'function' ? kit : null;
  }

  present(kit, cart) {
    return new Promise((resolve, reject) => {
      kit.present(cart.checkoutUrl, {
        onComplete: order => { this.finish(cart, order); resolve(order); },
        onCancel: () => { this.reveal(); resolve(null); },
        onError: err => { this.reveal(); reject(err); }
      });
    });
  }

  /**
   * Hosted checkout in a new tab. `noopener` matters: without it the
   * checkout document gets a handle on this one, which is the last window
   * that should be reachable from a page holding a health conversation.
   */
  openHosted(cart) {
    const tab = window.open(cart.checkoutUrl, '_blank', 'noopener,noreferrer');
    if (!tab) {
      this.reveal();
      this.chat?.fail('Your browser blocked the checkout window. Allow pop-ups for this page, then tap Checkout again.');
      return null;
    }
    // Nothing reports back from another tab, so say what's happening and
    // leave the basket alone until the pharmacy confirms the order.
    this.reveal();
    this.chat?.receive({
      text: 'Checkout is open in a new tab. Come back here when you’re done and we’ll confirm your order.'
    });
    return null;
  }

  finish(cart, order) {
    this.reveal();
    this.chat?.clearBasket();
    this.chat?.receive({
      text: 'Thanks — your order is in. We’ll message you here when it’s ready to collect.'
    });
    this.onOrder?.(order, cart);
  }

  reveal() { this.chat?.root.classList.remove('is-checkout'); }
}

/* ── Wiring ───────────────────────────────────────────────────────────
   const shop = new MedixlyShop();
   const chat = new SecureChat(el, { transport, shop, … });
   shop.attach(chat);

   Then either of these puts products in the thread:
     shop.search('claritin');
     chat.showProducts('', await shop.fetchProducts(''));

   A service-rail chip with `shop: true` runs the search locally, so
   browsing the shelf sends no message and involves no model.

   Not built yet, and both are server work:
     · Order confirmation from Shopify. `onOrder` fires from the SDK
       callback, which is the browser's word for it. A webhook on
       `orders/create` is what should actually confirm an order and post
       the receipt into the thread.
     · Basket persistence. Reload and the basket is gone. Fine for a first
       pass, worth fixing before anyone does a weekly shop in here.
─────────────────────────────────────────────────────────────────────── */
