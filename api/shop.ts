/**
 * GET  /api/shop/products?q=…  — search the products a patient may buy in chat
 * POST /api/shop/cart          — build a Shopify cart, get a checkoutUrl
 *
 * A proxy in front of Shopify's Storefront API, and the proxy is the point.
 *
 * Storefront access tokens are public by design, so the browser *could* call
 * Shopify directly. It must not, for one reason: **the allowlist has to be
 * unforgeable.** Only products the pharmacist has put in one specific Shopify
 * collection may be sold through the chat, and the only way to guarantee that is
 * to pin the collection handle here, server-side, where a crafted request can't
 * reach it. A client-side query is a suggestion; this is a rule.
 *
 * See docs/SHOP.md for why the allowlist exists at all — the short version is
 * that Canada schedules drugs, some of what a pharmacy stocks cannot lawfully be
 * sold from an unattended cart, and which is which is the pharmacist's call.
 *
 * Nothing here touches PHI. This module knows about products, quantities and a
 * contact email, and it must stay that way: see the guard on cart lines below.
 */

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN ?? "";
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN ?? "";
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-01";

/**
 * The one collection a patient can buy from. Curated by the pharmacist in the
 * Shopify admin, which makes the admin the control surface and "not sellable in
 * chat" the default — a new product is invisible here until someone adds it.
 */
const ALLOWLIST = process.env.SHOPIFY_CHAT_COLLECTION ?? "chat-eligible";

/** Hard ceiling on how much of the catalogue we will ever hold in memory. */
const MAX_CATALOGUE = 250;
const PAGE = 50;

/** Cache the allowlist briefly. A pharmacist's edit shows up within a minute. */
const CACHE_MS = 60_000;

const MAX_QUERY_CHARS = 80;
const MAX_LINES = 20;
const MAX_QTY = 12;

export interface ChatProduct {
  id: string;
  variantId: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  price: string;
  currency: string;
  image: string | null;
  imageAlt: string;
  available: boolean;
}

class BadRequest extends Error {
  constructor(public field: string, message: string) { super(message); }
}

/* The slices of the Storefront responses this module reads. Spelled out rather
   than typed `any` so a schema change surfaces here instead of at runtime. */

interface Money { amount: string; currencyCode: string }
interface Image { url: string; altText: string | null }

interface CatalogueResponse {
  collection: {
    id: string;
    title: string;
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        title: string;
        handle: string;
        productType: string | null;
        vendor: string | null;
        availableForSale: boolean;
        featuredImage: Image | null;
        variants: { nodes: Array<{ id: string; availableForSale: boolean; price: Money }> };
      }>;
    };
  } | null;
}

interface CartResponse {
  cartCreate: {
    cart: {
      id: string;
      checkoutUrl: string;
      totalQuantity: number;
      cost: { subtotalAmount: Money; totalAmount: Money };
      lines: {
        nodes: Array<{
          id: string;
          quantity: number;
          merchandise: {
            id: string;
            title: string;
            price: Money;
            product: { title: string; featuredImage: Image | null };
          };
        }>;
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/* ── Storefront transport ──────────────────────────────────────────── */

async function storefront<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!SHOP_DOMAIN || !STOREFRONT_TOKEN) {
    throw new Error("Shopify storefront credentials are not configured");
  }

  const res = await fetch(`https://${SHOP_DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    // Status only. The body can echo the request, and this runs next to a system
    // that keeps patient text out of its logs on purpose.
    throw new Error(`Shopify Storefront API ${res.status}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`Shopify Storefront API: ${body.errors[0].message}`);
  }
  return body.data as T;
}

const CATALOGUE_QUERY = `
  query ChatCatalogue($handle: String!, $first: Int!, $after: String) {
    collection(handle: $handle) {
      id
      title
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          productType
          vendor
          availableForSale
          featuredImage { url altText }
          variants(first: 1) {
            nodes {
              id
              availableForSale
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }`;

const CART_CREATE = `
  mutation ChatCartCreate($lines: [CartLineInput!]!, $email: String) {
    cartCreate(input: { lines: $lines, buyerIdentity: { email: $email } }) {
      cart {
        id
        checkoutUrl
        totalQuantity
        cost {
          subtotalAmount { amount currencyCode }
          totalAmount { amount currencyCode }
        }
        lines(first: 25) {
          nodes {
            id
            quantity
            merchandise {
              ... on ProductVariant {
                id
                title
                price { amount currencyCode }
                product { title featuredImage { url altText } }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }`;

/* ── The allowlist ─────────────────────────────────────────────────── */

let cache: { at: number; items: ChatProduct[] } | null = null;

/**
 * The whole allowlist collection, flattened and cached.
 *
 * Fetching everything and matching text here rather than asking Shopify to
 * search is deliberate. A curated pharmacy shortlist is small, and it means the
 * set a patient can reach is exactly the set in that collection — no search
 * syntax, no filter argument, and no Shopify-side default that quietly returns
 * more than intended when a field name is wrong.
 */
async function catalogue(): Promise<ChatProduct[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;

  const items: ChatProduct[] = [];
  let after: string | null = null;

  while (items.length < MAX_CATALOGUE) {
    // Annotated, not inferred: `after` is fed back in from the response below,
    // and without the annotation TypeScript reads that as a circular initializer.
    const data: CatalogueResponse = await storefront(CATALOGUE_QUERY, {
      handle: ALLOWLIST, first: PAGE, after,
    });

    const collection = data.collection;
    if (!collection) {
      // Not an error the patient caused. An empty rail is the right outcome —
      // better than falling back to the whole catalogue.
      console.error(`[shop] collection "${ALLOWLIST}" not found or not published to this token`);
      break;
    }

    for (const p of collection.products.nodes) {
      const variant = p.variants.nodes[0];
      if (!variant) continue;                       // nothing buyable
      items.push({
        id: p.id,
        variantId: variant.id,
        title: p.title,
        handle: p.handle,
        vendor: p.vendor ?? "",
        productType: p.productType ?? "",
        price: variant.price.amount,
        currency: variant.price.currencyCode,
        image: p.featuredImage?.url ?? null,
        imageAlt: p.featuredImage?.altText ?? p.title,
        available: p.availableForSale && variant.availableForSale,
      });
    }

    if (!collection.products.pageInfo.hasNextPage) break;
    after = collection.products.pageInfo.endCursor;
  }

  cache = { at: Date.now(), items };
  return items;
}

/** Every variant id a patient is allowed to put in a cart. */
async function sellableVariants(): Promise<Set<string>> {
  return new Set((await catalogue()).map((p) => p.variantId));
}

/* ── Search ────────────────────────────────────────────────────────── */

const normalise = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Words to drop before matching. The query is a whole sentence a patient typed —
 * "do you have any claritin please" — so without this, requiring every term to
 * appear in a product title finds nothing, which is exactly the bug this list
 * fixes. What's left is the part that names a thing.
 */
const NOISE = new Set([
  "a", "about", "also", "am", "an", "and", "any", "anything", "are", "at", "be",
  "been", "buy", "can", "carry", "could", "did", "do", "does", "for", "from", "get",
  "got", "has", "have", "hello", "hi", "how", "i", "id", "if", "im", "in", "is", "it",
  "its", "ive", "just", "kind", "like", "looking", "many", "may", "me", "much", "my",
  "need", "of", "on", "one", "or", "order", "please", "sell", "she", "some",
  "something", "sort", "still", "stock", "stuff", "thanks", "that", "the", "there",
  "they", "thing", "things", "this", "to", "want", "was", "we", "were", "what",
  "where", "which", "will", "with", "would", "you", "your",
]);

const terms = (query: string) => {
  const all = normalise(query).split(" ").filter(Boolean);
  const kept = all.filter((t) => !NOISE.has(t));
  // All noise — "do you have anything?" — is a request to browse, not a search
  // that found nothing.
  return kept.length ? kept : [];
};

/**
 * Match on title, vendor and product type. Every term has to appear somewhere,
 * so "claritin 30" narrows rather than widens.
 *
 * This searches product names, not symptoms. It is not a recommender: nothing
 * here maps a complaint to a product, because doing that is clinical advice and
 * belongs to a pharmacist. The agent enforces the same boundary before a query
 * ever reaches this function — see api/agent.ts.
 */
export function match(items: ChatProduct[], query: string): ChatProduct[] {
  const wanted = terms(query);
  if (!wanted.length) return items;

  return items
    .map((p) => {
      const haystack = normalise(`${p.title} ${p.vendor} ${p.productType}`);
      if (!wanted.every((t) => haystack.includes(t))) return null;
      // A hit in the title beats a hit in the vendor or the category, and
      // something we can actually sell beats something we can't.
      const inTitle = wanted.filter((t) => normalise(p.title).includes(t)).length;
      return { p, score: inTitle * 2 + (p.available ? 1 : 0) };
    })
    .filter((x): x is { p: ChatProduct; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_CHARS);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 6) || 6, 12);

    const found = match(await catalogue(), q);
    return json({ products: found.slice(0, limit), total: found.length }, 200);

  } catch (e) {
    console.error(e);
    return json({ error: "We couldn’t load the shop just now. Please try again." }, 502);
  }
}

/* ── Cart ──────────────────────────────────────────────────────────── */

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request" }, 400); }

  try {
    const raw = Array.isArray(body.lines) ? body.lines : [];
    if (!raw.length) throw new BadRequest("lines", "Your basket is empty");
    if (raw.length > MAX_LINES) throw new BadRequest("lines", "That's more items than we can take in one order");

    const sellable = await sellableVariants();

    // Only variant id and quantity cross this boundary. No cart attributes, no
    // note, no tags: a Shopify order must never carry why a patient is buying
    // something. See docs/SHOP.md.
    const lines = raw.map((line: any) => {
      const merchandiseId = String(line.variantId ?? "");
      if (!sellable.has(merchandiseId)) {
        // Either a stale card from before the pharmacist changed the collection,
        // or someone trying their luck. Same answer to both.
        throw new BadRequest("lines", "One of those items isn’t available to order here. A pharmacist can help.");
      }
      const quantity = Math.floor(Number(line.quantity ?? 1));
      if (!(quantity >= 1 && quantity <= MAX_QTY)) {
        throw new BadRequest("quantity", `Please choose between 1 and ${MAX_QTY} of each item.`);
      }
      return { merchandiseId, quantity };
    });

    const email = typeof body.email === "string" && body.email.includes("@")
      ? body.email : undefined;

    const data = await storefront<CartResponse>(CART_CREATE, { lines, email });
    const errors = data.cartCreate.userErrors;
    if (errors?.length) throw new BadRequest("cart", errors[0].message);

    const cart = data.cartCreate.cart;
    if (!cart) throw new Error("cartCreate returned no cart and no error");

    return json({
      id: cart.id,
      checkoutUrl: cart.checkoutUrl,
      totalQuantity: cart.totalQuantity,
      subtotal: cart.cost.subtotalAmount,
      total: cart.cost.totalAmount,
      lines: cart.lines.nodes.map((l: any) => ({
        id: l.id,
        quantity: l.quantity,
        variantId: l.merchandise.id,
        title: l.merchandise.product.title,
        price: l.merchandise.price,
        image: l.merchandise.product.featuredImage?.url ?? null,
      })),
    }, 201);

  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message, field: e.field }, 400);
    console.error(e);
    return json({ error: "We couldn’t start your order. Please try again." }, 502);
  }
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/* ── Before the pilot ─────────────────────────────────────────────────
   Rate limiting, as with every other public endpoint here.

   Cart mutation only. There is no `cartLinesUpdate` or `cartLinesRemove` proxy
   yet: the chat rebuilds the cart from its own basket state on every change,
   which is correct but chatty. Add them when basket editing gets busier.

   The allowlist protects *what* can be bought, not *how much*. Quantity caps
   above are a blunt instrument; a pharmacist should review whether any product
   in the collection needs a per-item limit, which is a Shopify Function rather
   than something to hardcode here.
─────────────────────────────────────────────────────────────────────── */
