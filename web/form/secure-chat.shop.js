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
    // Needed for the cart permalink the hosted path opens.
    this.shopDomain = opts.shopDomain ?? null;
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

    // The hosted path opens FIRST and synchronously. Safari and iOS discard
    // the user gesture across an `await`, so opening a tab after the cart
    // round trip is refused as a pop-up — which is exactly what "your browser
    // blocked the checkout window" was. A cart permalink needs no API call, so
    // there is nothing to wait for.
    const kit = this.peekKit();
    if (!kit) return this.openHosted(lines);

    // Only the embedded path needs a real cart, and only it puts a payment
    // surface over this page — so only it hides the transcript.
    const cart = await this.createCart(lines);
    if (!cart?.checkoutUrl) throw new Error('cart has no checkoutUrl');
    this.chat?.root.classList.add('is-checkout');

    try {
      return await this.present(kit, cart);
    } catch (err) {
      console.warn('[MedixlyShop] embedded checkout failed, opening hosted', err);
      this.reveal();
      return this.openHosted(lines);
    }
  }

  /**
   * A Shopify cart permalink: `/cart/{variantId}:{qty},…`. Numeric variant ids
   * only — the `gid://` form is rejected — so the tail of the GID is what goes
   * in. It carries nothing but what was bought and how many.
   */
  permalink(lines) {
    if (!this.shopDomain) return null;
    const parts = lines
      .map(l => `${String(l.variantId).split('/').pop()}:${l.quantity}`)
      .filter(part => /^\d+:\d+$/.test(part));
    return parts.length ? `https://${this.shopDomain}/cart/${parts.join(',')}` : null;
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
   * `@shopify/checkout-kit`, if the page has it. Synchronous on purpose — the
   * decision has to be made before the first `await`, or the gesture is gone.
   * Returns null rather than throwing so the hosted path is the quiet default.
   */
  peekKit() {
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
   * Hosted checkout in a new tab, opened on the tap with no await in front of
   * it.
   *
   * An anchor click rather than `window.open`, for two reasons. Browsers treat
   * a real anchor click inside a gesture as navigation rather than a pop-up, so
   * it survives where `window.open` gets blocked — notably on iOS. And
   * `window.open(url, '_blank', 'noopener')` returns null *by specification*,
   * because noopener means no handle: the old `if (!tab)` check therefore fired
   * every single time, telling patients their browser had blocked a window that
   * had in fact opened.
   *
   * `rel="noopener noreferrer"` still keeps the checkout document from getting
   * a handle on this one, which is the last window that should be reachable
   * from a page holding a health conversation.
   *
   * Nothing reports back from another tab, so the thread says what happened and
   * the basket is left alone until the pharmacy confirms the order.
   */
  openHosted(lines) {
    const url = this.permalink(lines);
    if (!url) {
      this.chat?.fail('We couldn\u2019t start checkout. Please call the pharmacy and we\u2019ll take the order.');
      return null;
    }

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();

    this.chat?.receive({
      text: 'Checkout is open in a new tab. Come back here when you\u2019re done and we\u2019ll confirm your order. If nothing opened, allow pop-ups for this page and tap Checkout again.'
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
