/**
 * Guards for the encrypted chat channel — CORS, rate limits, patient links.
 *
 *   npx tsx test/chat-guard.ts
 */

import {
  parseOrigins, allowOrigin, corsHeaders, patientLink, clientIp, RateLimiter,
  DEFAULT_ORIGINS,
} from "../supabase/functions/chat/guard.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const policy = parseOrigins(undefined);
const strict = parseOrigins("https://medixly.netlify.app,https://queue.example", true);

eq("defaults include the patient site", policy.allowed.has("https://medixly.netlify.app"), true);
eq("defaults include localhost", policy.allowed.has("http://localhost:8888"), true);
eq("the patient origin is allowed", allowOrigin("https://medixly.netlify.app", policy), "https://medixly.netlify.app");
eq("a random site is refused", allowOrigin("https://evil.example", policy), null);
eq("no origin is refused", allowOrigin(null, policy), null);
eq("a netlify preview is allowed by default",
  allowOrigin("https://deploy-preview-12--medixly.netlify.app", policy),
  "https://deploy-preview-12--medixly.netlify.app");
eq("bare netlify.app is not a wildcard match", allowOrigin("https://netlify.app", policy), null);
eq("http netlify is refused", allowOrigin("http://sneaky.netlify.app", policy), null);

eq("strict mode keeps listed origins",
  allowOrigin("https://queue.example", strict), "https://queue.example");
eq("strict mode drops the netlify wildcard",
  allowOrigin("https://random.netlify.app", strict), null);

{
  const headers = corsHeaders("https://evil.example", policy);
  eq("a foreign origin does not get *", headers["access-control-allow-origin"] === "*", false);
  eq("a foreign origin is not echoed", headers["access-control-allow-origin"] === undefined, true);
}
{
  const headers = corsHeaders("https://medixly.netlify.app", policy);
  eq("an allowed origin is echoed", headers["access-control-allow-origin"], "https://medixly.netlify.app");
  eq("CORS varies on Origin", headers.vary, "Origin");
}

eq("the patient link puts the token in the hash",
  patientLink("https://medixly.netlify.app/", "abc123"),
  "https://medixly.netlify.app/#t=abc123");
eq("a query token is not left on the link",
  patientLink("https://medixly.netlify.app/?t=old", "newtok").includes("?t="),
  false);
eq("the hash wins on a messy base",
  patientLink("https://medixly.netlify.app/", "tok").includes("#t=tok"),
  true);
check("DEFAULT_ORIGINS is what parseOrigins starts from",
  DEFAULT_ORIGINS.every((o) => policy.allowed.has(o)));

{
  const headers = { get: (n: string) => n.toLowerCase() === "cf-connecting-ip" ? "1.2.3.4" : null };
  eq("cf-connecting-ip is preferred", clientIp(headers), "1.2.3.4");
}
{
  const headers = { get: (n: string) => n.toLowerCase() === "x-forwarded-for" ? "9.9.9.9, 8.8.8.8" : null };
  eq("x-forwarded-for takes the first hop", clientIp(headers), "9.9.9.9");
}

{
  const lim = new RateLimiter(60_000, 3);
  const t0 = 1_000_000;
  eq("first hit is allowed", lim.hit("k", t0), true);
  eq("second hit is allowed", lim.hit("k", t0 + 10), true);
  eq("third hit is allowed", lim.hit("k", t0 + 20), true);
  eq("fourth hit in the window is refused", lim.hit("k", t0 + 30), false);
  eq("a different key is independent", lim.hit("other", t0 + 30), true);
  eq("after the window, hits are allowed again", lim.hit("k", t0 + 60_001), true);
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
