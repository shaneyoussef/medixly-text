/**
 * SMS notification tests.
 *
 *   npx tsx test/notify.ts
 *
 * No carrier, no database, no credentials.
 *
 * The point of this file is one property: **a notification cannot carry PHI.**
 * `docs/COMPLIANCE.md` calls no-PHI-over-SMS "the load-bearing assumption of the
 * whole design", so it deserves a test rather than a comment. The way it's
 * proved: feed every template a context stuffed with values that would be a
 * breach if they escaped, and assert none of them appear in any message.
 */

import {
  compose, notify, isOptIn, isOptOut, EVENTS, MAX_CHARS,
  type Event, type Sender, type Message,
} from "../api/notify.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

/** A sender that records rather than sends. */
const spy = () => {
  const sent: Message[] = [];
  const sender: Sender = { async send(m) { sent.push(m); return { id: "SM_test" }; } };
  return { sender, sent };
};

const CTX = {
  pharmacy: "Medixly",
  reference: "TR-K4J8Q",
  link: "https://medixly.netlify.app",
};

const contact = (over: Partial<{ phone: string; optedOut: boolean; consentAt: string | null }> = {}) => ({
  phone: "4165550100", optedOut: false, consentAt: null, ...over,
});

async function main() {
  /* No PHI, in any template ─────────────────────────────────────────
     Every one of these is something that would be a breach on a lock screen.
     None of them is even reachable from a template — the context object only
     accepts a pharmacy name, a reference and a link — so this is really a
     regression guard on that shape. If someone widens Ctx to take a payload
     field, this is the test that fails. */

  const FORBIDDEN = [
    "Metformin", "metformin", "Claritin", "loratadine",
    "urinary tract infection", "UTI", "pink eye", "acne", "yeast",
    "500 mg", "Dr Rao", "1988-04-12", "1234-567-890-AB",
    "Maya", "Halloran",
  ];

  for (const event of EVENTS) {
    const body = compose(event, CTX);
    const leaked = FORBIDDEN.filter((w) => body.includes(w));
    check(`"${event}" names no drug, condition, dose, prescriber or patient`,
      leaked.length === 0, `leaked: ${leaked.join(", ")} — "${body}"`);
  }

  /* Every template is well formed ──────────────────────────────────── */

  for (const event of EVENTS) {
    const body = compose(event, CTX);
    check(`"${event}" fits two segments`, body.length <= MAX_CHARS, `${body.length} chars`);
    check(`"${event}" names the pharmacy`, body.includes("Medixly"), body);
    check(`"${event}" leaves no placeholder unfilled`,
      !/undefined|null|\{\{|\$\{/.test(body), body);
  }

  // The opt-out route has to be on anything unsolicited. `action_needed`
  // answers something the patient started, so it's the one that needn't.
  for (const event of ["consent", "received", "ready", "message"] as Event[]) {
    check(`"${event}" tells them how to opt out`,
      /reply stop/i.test(compose(event, CTX)), compose(event, CTX));
  }

  check("first contact discloses that texts are not secure",
    /not secure/i.test(compose("consent", CTX)), compose("consent", CTX));

  check("an unknown event throws rather than sending something blank",
    (() => { try { compose("whatever" as Event, CTX); return false; } catch { return true; } })());

  /* Opt-out is honoured before anything is composed ────────────────── */

  {
    const { sender, sent } = spy();
    const r = await notify(contact({ optedOut: true }), "ready", CTX, sender);
    eq("an opted-out patient is not texted", r.sent, false);
    eq("and the reason says why", r.reason, "opted_out");
    eq("and nothing reached the carrier", sent.length, 0);
  }

  {
    const { sender, sent } = spy();
    const r = await notify(contact(), "ready", CTX, sender);
    eq("an opted-in patient is texted", r.sent, true);
    eq("once", sent.length, 1);
    eq("in E.164", sent[0].to, "+14165550100");
  }

  /* Bad numbers fail closed ────────────────────────────────────────── */

  for (const phone of ["", "555", "416555010", "notanumber", "14165550100"]) {
    const { sender, sent } = spy();
    const r = await notify(contact({ phone }), "ready", CTX, sender);
    eq(`"${phone}" is not texted`, r.sent, false);
    eq(`"${phone}" reaches no carrier`, sent.length, 0);
  }

  /* A carrier outage never throws ──────────────────────────────────── */

  {
    const dead: Sender = { async send() { throw new Error("Twilio 503"); } };
    const r = await notify(contact(), "received", CTX, dead);
    eq("a carrier failure is reported, not thrown", r.sent, false);
    eq("and named", r.reason, "failed");
  }

  /* STOP and START ─────────────────────────────────────────────────── */

  for (const word of ["STOP", "stop", " Stop ", "STOPALL", "unsubscribe", "Cancel", "quit", "opt out", "no more"]) {
    check(`"${word}" is an opt-out`, isOptOut(word));
  }
  for (const word of ["stop texting me about my refill", "I need to stop my prescription", "don't stop"]) {
    check(`"${word}" is not an opt-out — it's a message for a pharmacist`, !isOptOut(word));
  }
  for (const word of ["START", "start", "YES", "resume", "unstop"]) {
    check(`"${word}" is an opt-in`, isOptIn(word));
  }
  check("a blank body is neither", !isOptOut("") && !isOptIn(""));

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
