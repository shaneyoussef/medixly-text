/**
 * Classifier test harness.
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx test/run.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx test/run.ts --tag health-details
 *
 * Prints a per-message table, overall accuracy, and a confusion summary.
 * Review the misses by hand — the goal is not 100%, it's understanding
 * *which* mistakes the classifier makes and whether they're safe ones.
 */

import { readFileSync } from "node:fs";
import { classify, type Classification, type Intent } from "../api/classify.js";

interface Case {
  id: number;
  msg: string;
  expect: Intent;
  tag: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL("./messages.json", import.meta.url), "utf8"),
);

const tagFilter = process.argv.includes("--tag")
  ? process.argv[process.argv.indexOf("--tag") + 1]
  : null;

const selected = tagFilter ? cases.filter((c) => c.tag === tagFilter) : cases;

// Mistakes that land on a human are acceptable. Mistakes that send a patient
// with a clinical concern to a self-serve form are not.
const SAFE_MISS: Intent[] = ["PHARMACIST_CHAT", "UNCLEAR"];

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY first.");
    process.exit(1);
  }

  const results: Array<{ c: Case; got: Classification; ok: boolean }> = [];

  console.log(
    `\n${pad("ID", 4)}${pad("MESSAGE", 44)}${pad("EXPECTED", 17)}${pad("GOT", 17)}${pad("CONF", 6)}PHI`,
  );
  console.log("-".repeat(94));

  for (const c of selected) {
    let got: Classification;
    try {
      got = await classify(c.msg);
    } catch (err) {
      console.error(`  ${c.id} FAILED: ${(err as Error).message}`);
      continue;
    }

    const ok = got.intent === c.expect;
    results.push({ c, got, ok });

    const mark = ok ? "  " : SAFE_MISS.includes(got.intent) ? "~ " : "X ";
    console.log(
      mark +
        pad(String(c.id), 4) +
        pad(c.msg, 44) +
        pad(c.expect, 17) +
        pad(got.intent, 17) +
        pad(got.confidence.toFixed(2), 6) +
        (got.contains_health_details ? "yes" : ""),
    );

    // Be kind to the rate limiter.
    await new Promise((r) => setTimeout(r, 250));
  }

  const hits = results.filter((r) => r.ok).length;
  const misses = results.filter((r) => !r.ok);
  const unsafe = misses.filter((r) => !SAFE_MISS.includes(r.got.intent));

  console.log("-".repeat(94));
  console.log(
    `\nAccuracy      ${hits}/${results.length} (${((hits / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Safe misses   ${misses.length - unsafe.length}  (routed to a human — acceptable)`,
  );
  console.log(
    `Unsafe misses ${unsafe.length}  (sent to the wrong self-serve form — fix these)`,
  );

  if (unsafe.length) {
    console.log("\nUnsafe misses:");
    for (const r of unsafe) {
      console.log(`  ${r.c.id}. "${r.c.msg}"`);
      console.log(`      expected ${r.c.expect}, got ${r.got.intent} @ ${r.got.confidence}`);
    }
  }

  // Where did each expected intent actually land?
  const byExpected = new Map<string, Map<string, number>>();
  for (const r of results) {
    const row = byExpected.get(r.c.expect) ?? new Map();
    row.set(r.got.intent, (row.get(r.got.intent) ?? 0) + 1);
    byExpected.set(r.c.expect, row);
  }

  console.log("\nWhere each intent landed:");
  for (const [expected, row] of byExpected) {
    const parts = [...row.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([got, n]) => `${got}x${n}`)
      .join("  ");
    console.log(`  ${pad(expected, 17)}${parts}`);
  }

  // PHI flag check — every message tagged health-details should be flagged.
  const phiCases = results.filter((r) => r.c.tag === "health-details");
  const phiMissed = phiCases.filter((r) => !r.got.contains_health_details);
  if (phiCases.length) {
    console.log(
      `\nPHI detection ${phiCases.length - phiMissed.length}/${phiCases.length} flagged`,
    );
    for (const r of phiMissed) console.log(`  missed: "${r.c.msg}"`);
  }

  console.log();
}

main();
