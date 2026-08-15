/**
 * Message encryption tests.
 *
 *   npx tsx test/crypto.ts
 *
 * No database, no network, no Deno. This imports the *same* module the edge
 * function imports, which is the point of crypto.ts being its own file — a
 * copy of the scheme living down here would pass happily while the deployed
 * function drifted away from it.
 *
 * The property being defended: a message body is unreadable to anything that
 * has the database but not the key. Everything else in this file exists to
 * make sure that stays true under rotation, tampering and bad configuration.
 */

import {
  parseKeys, seal, open, openAll, b64u,
  PURGED, NOTE_NO_KEY, NOTE_TAMPERED, NOTE_PURGED,
  type Keyring,
} from "../supabase/functions/chat/crypto.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

async function main() {
  const K2 = randomKey(), K1 = randomKey();
  const keys = await parseKeys(`k2:${K2},k1:${K1}`);

  eq("the newest key is the one that encrypts", keys.current, "k2");
  eq("but both keys can decrypt", keys.map.size, 2);

  /* Round trips ─────────────────────────────────────────────────────
     The awkward inputs are the point: a pharmacy chat carries accents,
     apostrophes, emoji from patients, and the occasional 4000-character
     explanation of a symptom. */

  const SAMPLES = [
    "Hi, my throat has been sore for three days.",
    "Metformin 500 mg — is it OK to take with food?",
    "accents éèçñ, emoji 💊🤒, quotes “it’s”",
    "x".repeat(4000),
    ".",
    "mx1.k1.notreally.anenvelope",     // looks like ours, isn't
    "   leading and trailing   ",
  ];

  for (const text of SAMPLES) {
    const sealed = await seal(keys, text);
    const label = JSON.stringify(text.length > 26 ? text.slice(0, 26) + "…" : text);

    eq(`round trips ${label}`, await open(keys, sealed), text);
    check(`${label} is well formed`, /^mx1\.k2\.[\w-]+\.[\w-]+$/.test(sealed), sealed.slice(0, 40));

    // Against the ciphertext segment alone. Testing the whole envelope would
    // "find" a plaintext of "." in the envelope's own dots.
    const raw = new TextDecoder().decode(b64u.decode(sealed.split(".")[3]));
    check(`${label} does not survive in the ciphertext`, !raw.includes(text.slice(0, 16)));
  }

  /* A fresh iv every time ───────────────────────────────────────────
     Two patients typing the same sentence must not produce the same row.
     Without this, anyone with the table learns who said what by matching. */

  const a = await seal(keys, "same words"), b = await seal(keys, "same words");
  check("the same words seal differently each time", a !== b);
  eq("and both still open", await open(keys, a), "same words");
  eq("...to the same thing", await open(keys, b), "same words");

  /* Tampering ───────────────────────────────────────────────────────
     GCM authenticates. A flipped bit has to be refused, not returned as
     plausible-looking text — this channel carries dosing instructions. */

  {
    const parts = (await seal(keys, "Take one tablet daily")).split(".");
    const ct = b64u.decode(parts[3]);
    ct[3] ^= 0x01;
    parts[3] = b64u.encode(ct);
    eq("a flipped bit in the ciphertext is refused", await open(keys, parts.join(".")), NOTE_TAMPERED);
  }
  {
    const parts = (await seal(keys, "Take one tablet daily")).split(".");
    const iv = b64u.decode(parts[2]);
    iv[0] ^= 0x01;
    parts[2] = b64u.encode(iv);
    eq("a flipped bit in the iv is refused", await open(keys, parts.join(".")), NOTE_TAMPERED);
  }
  eq("a truncated envelope is refused", await open(keys, "mx1.k2.abc"), NOTE_TAMPERED);

  /* Rotation ────────────────────────────────────────────────────────
     The reason the key id rides along in the envelope. Add a key at the
     front; yesterday's messages still open. */

  {
    const older = await seal(await parseKeys(`k1:${K1}`), "sealed before the rotation");
    check("a message sealed under the old key names it", older.startsWith("mx1.k1."));
    eq("and the rotated keyring still opens it", await open(keys, older), "sealed before the rotation");

    const retired = await parseKeys(`k2:${K2}`);          // k1 dropped too early
    eq("dropping a key that history still needs degrades, not throws",
      await open(retired, older), NOTE_NO_KEY);
  }

  /* Things that are not ciphertext ──────────────────────────────────── */

  eq("a row from before encryption is passed through",
    await open(keys, "plain text written by the old function"),
    "plain text written by the old function");
  eq("a purged row says so", await open(keys, PURGED), NOTE_PURGED);

  /* A thread opens in order ─────────────────────────────────────────── */

  {
    const thread = await Promise.all(
      ["first", "second", "third"].map(async (t, i) => ({ i, body: await seal(keys, t) })),
    );
    const opened = await openAll(keys, thread);
    eq("a thread comes back in order", opened.map((m) => m.body).join(","), "first,second,third");
    eq("and keeps its other columns", opened.map((m) => m.i).join(","), "0,1,2");
  }

  /* Bad configuration fails closed ──────────────────────────────────
     Every one of these must leave `current` null, because the caller reads
     that to decide whether to serve at all. Half-working is the one outcome
     that would put plaintext in the column. */

  for (const [label, raw] of [
    ["empty", ""],
    ["whitespace", "   "],
    ["no id", "justakey"],
    ["not base64", "k1:!!!!not base64!!!!"],
    ["too short", `k1:${btoa("sixteen bytes!!!")}`],
    ["id contains a dot", `k.1:${K1}`],
  ] as const) {
    const bad = await parseKeys(raw);
    eq(`${label} leaves no encrypting key`, bad.current, null);
    await check(`${label} refuses to seal`,
      await seal(bad, "x").then(() => false, () => true));
  }

  {
    // One broken entry must not cost the good one beside it.
    const mixed = await parseKeys(`broken,k1:${K1}`);
    eq("a broken entry is skipped, the good one survives", mixed.current, "k1");
  }

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
