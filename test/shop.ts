/**
 * Shop matcher tests.
 *
 *   npx tsx test/shop.ts
 *
 * No network, no Shopify credentials. `match()` is the only real logic in
 * `api/shop.ts` — everything else is a GraphQL call — and it decides what a
 * patient sees when they ask for something, so it is worth pinning down.
 *
 * The fixtures are real product titles from the InstaCare catalogue, so a
 * regression shows up as "asking for Claritin stops finding Claritin" rather
 * than as an abstract failure.
 */

import { match, type ChatProduct } from "../api/shop.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}

const product = (
  title: string, vendor: string, productType: string,
  price: string, available = true,
): ChatProduct => ({
  id: `gid://shopify/Product/${title.length}`,
  variantId: `gid://shopify/ProductVariant/${title.length}`,
  title, handle: title.toLowerCase().replace(/\W+/g, "-"),
  vendor, productType, price, currency: "CAD",
  image: null, imageAlt: title, available,
});

const CATALOGUE: ChatProduct[] = [
  product("Claritin Allergy 24-Hour, 10 Tablets", "Claritin", "Allergy and Sinus", "11.49"),
  product("Claritin Allergy 24-Hour, 20 Tablets", "Claritin", "Allergy and Sinus", "22.99"),
  product("Claritin Allergy 24-Hour, 30 Tablets", "Claritin", "Allergy and Sinus", "26.99"),
  product("Allegra Allergies 24-Hour Relief, 12 Tablets", "Allegra", "Allergy and Sinus", "14.99"),
  product("Aerius Desloratadine Tablets USP 5 mg - 40 Tablets", "Aerius", "Allergy and Sinus", "44.99", false),
  product("health One Loratadine Allergy Remedy 10 mg - 12 Tablets", "health One", "Allergy and Sinus", "10.99"),
  product("Breathe Right Nasal Strips, Extra Strength - 8 Strips", "Breathe", "Allergy and Sinus", "10.49"),
  product("Thrive Nicotine Lozenges, Peppermint - 108 Lozenges", "Thrive", "Smoking Cessation", "38.99"),
];

const titles = (found: ChatProduct[]) => found.map((p) => p.title);

function main() {
  /* A patient types a sentence, not a search term ────────────────────
     This is the case that matters. Without stopword removal, requiring every
     term to appear in a title means a polite question finds nothing at all. */

  const phrasings = [
    "claritin",
    "do you have claritin",
    "Do you have any Claritin please?",
    "im looking for claritin",
    "I need Claritin",
    "hi do you sell claritin",
  ];
  for (const q of phrasings) {
    const found = match(CATALOGUE, q);
    check(
      `"${q}" finds the Claritin products`,
      found.length === 3 && found.every((p) => p.vendor === "Claritin"),
      `got ${found.length}: ${titles(found).join(" | ")}`,
    );
  }

  /* Narrowing ─────────────────────────────────────────────────────── */

  const narrowed = match(CATALOGUE, "claritin 20 tablets");
  check(
    "extra terms narrow rather than widen",
    narrowed.length === 1 && narrowed[0].title.includes("20 Tablets"),
    `got ${titles(narrowed).join(" | ")}`,
  );

  const byVendor = match(CATALOGUE, "aerius");
  check("a brand with one product finds just it", byVendor.length === 1, titles(byVendor).join(" | "));

  const byCategory = match(CATALOGUE, "smoking cessation");
  check(
    "a category name matches productType",
    byCategory.length === 1 && byCategory[0].vendor === "Thrive",
    titles(byCategory).join(" | "),
  );

  const multiword = match(CATALOGUE, "nasal strips");
  check("a two-word product name matches", multiword.length === 1, titles(multiword).join(" | "));

  /* Browsing ──────────────────────────────────────────────────────── */

  check("an empty query returns the whole shelf", match(CATALOGUE, "").length === CATALOGUE.length);
  check(
    "a query that is all filler returns the whole shelf, not nothing",
    match(CATALOGUE, "do you have anything").length === CATALOGUE.length,
    `got ${match(CATALOGUE, "do you have anything").length}`,
  );

  /* Nothing found is a real answer ────────────────────────────────── */

  check("something not stocked returns nothing", match(CATALOGUE, "ibuprofen").length === 0);
  check(
    "a plausible-but-absent brand returns nothing rather than a near miss",
    match(CATALOGUE, "reactine").length === 0,
  );

  /* Ordering ──────────────────────────────────────────────────────── */

  const mixed = match(CATALOGUE, "allergy");
  check(
    "in-stock items rank above out-of-stock",
    mixed.length > 1 && mixed[mixed.length - 1].available === false,
    titles(mixed).join(" | "),
  );

  const loratadine = match(CATALOGUE, "loratadine");
  check(
    "a title hit outranks a vendor-only hit",
    loratadine[0].title.toLowerCase().includes("loratadine"),
    titles(loratadine).join(" | "),
  );

  /* Case and punctuation ──────────────────────────────────────────── */

  check("matching ignores case", match(CATALOGUE, "CLARITIN").length === 3);
  check("matching ignores punctuation", match(CATALOGUE, "claritin, 10 tablets.").length === 1);

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log();
    process.exit(1);
  }
  console.log();
}

main();
