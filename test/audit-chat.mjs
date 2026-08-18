/**
 * Security audit for the encrypted messaging channel.
 *
 *   STAFF_KEY=... REFERENCE=TR-XXXXX node test/audit-chat.mjs
 *
 * Black box, on purpose. It knows the staff key and a request reference and
 * nothing else — the same things an attacker who stole a laptop would have —
 * and it probes the live function over HTTPS exactly as a browser does. Unit
 * tests prove the algorithm; this proves the deployment.
 *
 * Safe to run against production. It creates a chat on the reference you name,
 * sends two clearly-marked test messages, and revokes the link at the end. It
 * never deletes anything.
 *
 * What it CANNOT check, and who has to:
 *
 *   Ciphertext at rest   Needs database access. Run the query printed at the
 *                        end, or ask me and I'll run it — a body that does not
 *                        begin `mx1.` means encryption is not on.
 *   Staff identity       Everyone shares one key, so the audit log says
 *                        "staff" and not which one. Known, and the thing that
 *                        blocks a pilot. No script can test around it.
 *   The people part      Who has the staff key, where it is written down, what
 *                        happens when someone leaves.
 */

const BASE = process.env.CHAT_URL_API
  ?? "https://vejzchchrliqrlzlepkc.supabase.co/functions/v1/chat";
const KEY = process.env.STAFF_KEY ?? "";
const REF = process.env.REFERENCE ?? "";

if (!KEY || !REF) {
  console.error("Usage: STAFF_KEY=... REFERENCE=TR-XXXXX node test/audit-chat.mjs");
  process.exit(2);
}

let pass = 0;
const bad = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { bad.push(name + (detail ? ` — ${detail}` : "")); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function call(qs, { method = "GET", key, body } = {}) {
  const res = await fetch(BASE + qs, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "x-staff-key": key }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = {};
  try { json = await res.json(); } catch { /* some errors have no body */ }
  return { status: res.status, json, headers: res.headers };
}

const staff = (qs, opts = {}) => call(qs, { key: KEY, ...opts });

function tokenFromLink(link) {
  const u = new URL(link);
  return u.searchParams.get("t")
    || new URLSearchParams(u.hash.replace(/^#/, "")).get("t");
}

console.log(`\nAuditing ${BASE}\n`);

/* ── 1. It refuses everything it should ───────────────────────────── */
console.log("Access control");
{
  const r = await staff(`?reference=${REF}`);
  if (r.status === 503) {
    console.error("\n  The function is not configured — STAFF_KEY or MESSAGE_KEYS is missing.");
    console.error("  It is failing closed, which is correct, but nothing else can be tested.\n");
    process.exit(1);
  }
  ok("a valid staff key is accepted", r.status === 200, `got ${r.status} ${r.json.error ?? ""}`);
}
ok("no staff key is refused", (await call(`?reference=${REF}`)).status === 401);
ok("a wrong staff key is refused", (await call(`?reference=${REF}`, { key: "wrong-key-entirely" })).status === 401);
ok("a staff key of the right length but wrong value is refused",
  (await call(`?reference=${REF}`, { key: "x".repeat(KEY.length) })).status === 401);
ok("a made-up patient token is refused", (await call("?t=notarealtokenatall")).status === 404);
ok("staff route with no reference is refused", (await staff("")).status === 400);
ok("an unknown reference is refused", (await staff("?reference=TR-DOESNOTEXIST")).status === 404);
{
  const r = await fetch(BASE + `?reference=${REF}`, {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
  });
  const acao = r.headers.get("access-control-allow-origin");
  ok("a foreign origin is not allowed via CORS", acao !== "*" && acao !== "https://evil.example",
    `got ${acao}`);
}

/* ── 2. Opening a chat ────────────────────────────────────────────── */
console.log("\nOpening a conversation");
const opened = await staff(`?reference=${REF}`, { method: "POST", body: { open: true } });
ok("staff can open a secure chat", opened.status === 201 && !!opened.json.link,
  `got ${opened.status} ${opened.json.error ?? ""}`);
if (!opened.json.link) { report(); process.exit(1); }

let token = tokenFromLink(opened.json.link);
ok("the link carries a token", !!token);
ok("the token is in the hash, not the query string",
  (opened.json.link ?? "").includes("#t=") && !(opened.json.link ?? "").includes("?t="),
  opened.json.link);
ok("the token is long enough to not be guessable", (token ?? "").length >= 20, `${token?.length} chars`);
ok("the link expires", !!opened.json.expires_at);
{
  const days = (new Date(opened.json.expires_at) - Date.now()) / 864e5;
  ok("...within a sane window", days > 0 && days <= 31, `${days.toFixed(1)} days`);
}
{
  const renewed = await staff(`?reference=${REF}`, { method: "POST", body: { open: true } });
  const token2 = tokenFromLink(renewed.json.link ?? "");
  ok("renewing mints a new token", !!token2 && token2 !== token, "renew reused the leaked token");
  ok("the old token dies on renew", (await call(`?t=${token}`)).status === 404);
  // The rest of the audit uses the live token.
  if (token2) token = token2;
}

/* ── 3. The round trip ────────────────────────────────────────────── */
console.log("\nRound trip");
const stamp = Date.now();
const FROM_PATIENT = `AUDIT patient message ${stamp}`;
const FROM_STAFF = `AUDIT pharmacist reply ${stamp}`;

ok("a patient can send with only the token",
  (await call(`?t=${token}`, { method: "POST", body: { body: FROM_PATIENT } })).status === 201);
ok("a pharmacist can reply",
  (await staff(`?reference=${REF}`, { method: "POST", body: { body: FROM_STAFF, author: "Audit" } })).status === 201);

{
  const patientView = await call(`?t=${token}`);
  const bodies = (patientView.json.messages ?? []).map((m) => m.body);
  ok("the patient sees their own message", bodies.includes(FROM_PATIENT));
  ok("the patient sees the pharmacist's reply", bodies.includes(FROM_STAFF));

  const staffView = await staff(`?reference=${REF}`);
  const sBodies = (staffView.json.messages ?? []).map((m) => m.body);
  ok("the pharmacist sees the same two messages",
    sBodies.includes(FROM_PATIENT) && sBodies.includes(FROM_STAFF));
  ok("both sides decrypt cleanly — nothing unreadable",
    !sBodies.some((b) => b.startsWith("[unreadable")),
    "a message failed to decrypt; check MESSAGE_KEYS still contains the key it was sealed with");

  ok("reading marks the patient's message read",
    (staffView.json.messages ?? []).some((m) => m.sender === "patient" && m.read_at));
}

/* ── 4. What the patient token may not do ─────────────────────────── */
console.log("\nToken scope");
{
  // The token names one request. Handing it a different reference must not
  // widen it — a leaked link should expose one conversation, not a history.
  const r = await call(`?t=${token}&reference=TR-DOESNOTEXIST`);
  ok("a token plus someone else's reference still returns only its own thread",
    r.status === 200 && r.json.reference === REF, `got reference ${r.json.reference}`);
}
ok("a patient token cannot open a new chat",
  (await call(`?t=${token}`, { method: "POST", body: { open: true } })).status !== 201);
ok("an empty message is refused",
  (await call(`?t=${token}`, { method: "POST", body: { body: "   " } })).status === 400);
ok("an oversized message is refused",
  (await call(`?t=${token}`, { method: "POST", body: { body: "x".repeat(4001) } })).status === 400);
ok("a malformed body is refused",
  (await fetch(`${BASE}?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status === 400);

/* ── 5. Revoking ──────────────────────────────────────────────────── */
console.log("\nRevoking");
ok("staff can revoke",
  (await staff(`?reference=${REF}`, { method: "POST", body: { revoke: true } })).status === 200);
ok("the revoked token stops working immediately",
  (await call(`?t=${token}`)).status === 404);
ok("...for sending too",
  (await call(`?t=${token}`, { method: "POST", body: { body: "should not land" } })).status === 404);
{
  const after = await staff(`?reference=${REF}`);
  ok("staff can still read the history after revoking", after.status === 200);
  ok("...and the record is intact", (after.json.messages ?? []).length >= 2);
  ok("no live link is advertised any more", !after.json.link);
}

report();

function report() {
  const total = pass + bad.length;
  console.log(`\n${pass}/${total} checks passed`);
  if (bad.length) {
    console.log("\nFailures:");
    for (const f of bad) console.log(`  ✗ ${f}`);
  }
  console.log(`
Still to check by hand — this script cannot:

  1. Encryption at rest. In the Supabase SQL editor:

       select left(body, 12) as starts_with, length(body)
         from messages order by created_at desc limit 5;

     Every row must begin "mx1." . If you can read the words, the messages
     are not encrypted and MESSAGE_KEYS is not doing its job.

  2. The audit log holds no message text:

       select action, detail from audit_log
        where action like '%message%' order by at desc limit 10;

     detail must never contain what anyone wrote.

  3. Who has the staff key, and what happens when they leave. Everyone shares
     one, so the log cannot say which person read a record. That is the open
     item that blocks a pilot.
`);
  process.exit(bad.length ? 1 : 0);
}
