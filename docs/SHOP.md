# Shop

Over-the-counter ordering inside the patient chat, on Shopify.

A patient asks for something on the shelf, sees product cards in the thread, adds
to a basket and pays — without leaving the page. If what they actually described
was a symptom, they get a pharmacist instead of a product.

## The direction of the embedding is the whole design

**Products come into the chat. The chat does not go into the Shopify storefront.**

That was the one part of the original request worth pushing back on. A storefront
page runs theme JavaScript, installed apps, and whatever marketing pixels are
configured — Meta, Google, TikTok. Mount a patient's health conversation in that
document and those scripts sit in the same DOM as it, with access to page content
and interactions. That is the failure mode behind the US patient-portal pixel
settlements, and under PHIPA it is a disclosure without consent.

Inverting it costs nothing. The Storefront API is a read-only JSON fetch, so the
only Shopify traffic on the chat page is our own proxy plus images from their CDN.
**No Shopify script is loaded.** Keep it that way: an "easy" theme-app-extension
version of this feature is a privacy regression, not a shortcut.

## Files

| File | What's in it |
| --- | --- |
| `api/shop.ts` | The proxy. Products and cart, pinned to the allowlist collection. |
| `web/form/secure-chat.shop.js` | `MedixlyShop`: search, cart, checkout, and the Checkout Kit fallback. |
| `secure-chat.core.js` | The `products` and `basket` card kinds, and basket state. |
| `test/shop.ts` | The matcher, against real catalogue titles. |

## The allowlist

Only products in one curated Shopify collection can be bought in the chat. The
handle comes from `SHOPIFY_CHAT_COLLECTION` and defaults to `chat-eligible`.

**Why it exists.** Canada schedules drugs through NAPRA. Schedule II is
behind-the-counter with pharmacist intervention; Schedule III is self-selection
only within the pharmacy's professional services area; unscheduled is open sale.
Not everything a pharmacy stocks may lawfully be sold from an unattended cart, and
which is which is a pharmacist's judgment — the same reason `SCREENING` in
`secure-chat.forms.js` is empty. **Nobody should classify the catalogue by
guessing, and this codebase does not.**

**Why it's a Shopify collection.** The pharmacist curates it in the admin they
already use, and the default is "not sellable in chat" — a newly imported product
is invisible to patients until someone adds it. That is the right way round.

**Why the proxy enforces it.** Storefront tokens are public, so the browser could
call Shopify directly. It must not: the collection handle is pinned server-side in
`api/shop.ts`, and `POST /api/shop/cart` re-checks every variant against the
allowlist before creating a cart. A client-side filter is a suggestion; this is a
rule.

The InstaCare catalogue is mostly self-selection OTC — antihistamines, nasal
strips, first aid. The items worth a specific look before they go in the
collection are the **nicotine lozenges** under Smoking Cessation. There is no
codeine, pseudoephedrine or emergency contraception in it today; if any is added
later, the allowlist is what stops it appearing in the chat.

## The refusal boundary

An agent that answers "what can I take for my itchy eyes" with a product is
giving clinical advice. It must not.

The rule is drawn on a signal the classifier already computes,
`contains_health_details`:

| Message | Classified | Result |
| --- | --- | --- |
| "do you have Claritin" | `OTC_ORDER`, no health details | Product cards |
| "what can I take for my itchy eyes" | `OTC_ORDER`, health details | Callback form, **no products** |
| "my eye is red and goopy" | `MINOR_AILMENT` | Assessment form |
| "can I take this with my other pills" | `PHARMACIST_CHAT` | Callback form |

Only `OTC_ORDER` ever returns a `shopQuery`, and only when the flag is clear.
`test/agent.ts` asserts every row of that table, including that no clinical intent
can carry a shop query.

**This makes PHI detection load-bearing in a new way.** `docs/CLASSIFIER.md`
describes that flag as driving shortened retention. It now also draws a clinical
safety line, so a miss is no longer only a privacy problem. The separate
PHI-detection score in `test/run.ts` is the number to watch.

## Checkout

`cartCreate` returns a `checkoutUrl`. Two ways to use it:

1. **Checkout Kit (web).** `@shopify/checkout-kit` renders Shopify's real checkout
   inside the page over the Embedded Checkout Protocol. Shopify takes the payment,
   applies tax, and creates the order.
2. **Hosted tab.** The same URL in a new window.

`MedixlyShop.checkout()` tries the first and falls back to the second. The
fallback is not padding: **Checkout Kit's web SDK is pre-general-availability**,
so the hosted tab is the path that is guaranteed to work today. Never hand-roll an
iframe around `checkoutUrl` instead — framing checkout is blocked, and ECP is the
supported way in.

While checkout is open the chat sets `is-checkout` on the root, which hides the
message history. A health conversation has no business sitting behind a payment
surface. Cards stay visible so the basket is still legible.

Two things follow from Shopify being merchant of record: **no card details ever
touch this system**, which is a better PCI position than any bespoke payment
form; and on the **Basic** plan, checkout branding and checkout UI extensions are
Plus features, so the checkout panel will look like Shopify's default rather than
the Medixly design system. The chat around it is ours; the panel is not.

## What must never reach Shopify

A Shopify order records **what** was bought, never **why**.

No cart line attributes, no order note, no order tags naming a condition, a
symptom or a prescription. `createCart` in `secure-chat.shop.js` sends variant ids
and quantities; `api/shop.ts` accepts nothing else and would drop it if it did.

This matters because of what `docs/PIA.md` §3 already established: identifying
information relating to the provision of health care is PHI, and the fact that a
named patient bought a particular health product from a pharmacy can fall inside
that. Vitamins, probably not. A pregnancy test, plausibly. So Shopify is a service
provider that may hold low-sensitivity PHI, and it needs the same treatment as any
other — see the PIA rows added for it, and note that Shopify hosts largely outside
Canada, which is a live question against the residency line in
`docs/COMPLIANCE.md`.

## Not built

- **Order confirmation is the browser's word for it.** `onOrder` fires from the
  SDK callback. A webhook on `orders/create` is what should actually confirm an
  order and post the receipt into the thread.
- **No basket persistence.** Reload and it's gone.
- **No `cartLinesUpdate`.** The chat rebuilds the cart from its own basket on
  every change — correct, but chatty.
- **No rate limit** on `/api/shop`, as with every other endpoint here.
- **`OTC_ORDER` in the queue is still unwired.** `api/submit.ts` accepts it for the
  unpaid case — "set this aside", "can you order this in" — and nothing sends one
  yet. A paid item is a Shopify order and Shopify is the record; don't create both
  for the same purchase.

## Configuration

```
SHOPIFY_SHOP_DOMAIN=f1u1zc-8t.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=…      # Headless channel, Shopify admin
SHOPIFY_CHAT_COLLECTION=chat-eligible
SHOPIFY_API_VERSION=2025-01
```

The collection does not exist yet — create it and add the products a patient may
buy. Until it does, the proxy logs that it can't find it and the shop returns
nothing, which is the correct failure: an empty shelf, never the whole catalogue.

One more open decision: the store is branded **InstaCare** and the chat says
**Medixly**. Pick one before a patient sees both.
