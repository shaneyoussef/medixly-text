/**
 * Agent test harness.
 *
 *   npx tsx test/agent.ts
 *
 * No API key, no network. `test/run.ts` measures the classifier; this measures
 * what the agent *does* with a classification, so every case here stubs the
 * classifier and asserts on the routing decision.
 *
 * The classifier's accuracy is a tuning question. These are not: each one is a
 * rule the system is supposed to hold, and a failure here is a bug.
 *
 * One "[agent] classification failed" line in the output is expected — the
 * outage case asserts the agent logs and degrades rather than throwing.
 */

import {
  respond,
  isEmergency,
  MAX_MESSAGE_CHARS,
  type AgentContext,
} from "../api/agent.js";
import type { Classification, Intent } from "../api/classify.js";

/* ── Harness ───────────────────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}

const eq = (name: string, got: unknown, want: unknown) =>
  check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

/** A classifier that always returns the same thing. */
const stub = (
  intent: Intent,
  over: Partial<Classification> = {},
) => async (): Promise<Classification> => ({
  intent,
  confidence: intent === "UNCLEAR" ? 0.4 : 0.95,
  clarifying_question: intent === "UNCLEAR" ? "Is this a refill or something else?" : null,
  contains_health_details: false,
  ...over,
});

const ask = (message: string, intent: Intent, ctx: AgentContext = {}) =>
  respond(message, { classify: stub(intent), ...ctx });

/* ── Cases ─────────────────────────────────────────────────────────── */

async function main() {
  /* Emergencies short-circuit ───────────────────────────────────────
     The tripwire runs before the classifier, so "call 911" survives an
     Anthropic outage. These assert both halves: it fires, and it fires
     without the classifier being consulted. */

  const emergencies = [
    "having chest pain and shortness of breath",
    "I can't breathe properly",
    "my cut won't stop bleeding",
    "I've been having thoughts about hurting myself",
    "trouble breathing since this morning",
  ];
  for (const msg of emergencies) {
    check(`emergency tripwire fires: "${msg}"`, isEmergency(msg));
  }

  check(
    "ordinary messages don't trip it",
    !["I need a refill", "do you carry vitamin d", "my eye is red and goopy"]
      .some(isEmergency),
  );

  let classifierCalled = false;
  const emergency = await respond("having chest pain", {
    classify: async () => { classifierCalled = true; return stub("REFILL")(); },
  });
  check("emergency skips the classifier entirely", !classifierCalled);
  eq("emergency escalates", emergency.escalate, true);
  eq("emergency pushes no form", emergency.form, null);
  check("emergency reply says 911", /\b911\b/.test(emergency.reply));
  check(
    "emergency reply offers no second number to try",
    !/call us at/.test(emergency.reply),
    emergency.reply,
  );

  /* Intent → form ──────────────────────────────────────────────────── */

  const forms: Array<[Intent, string | null]> = [
    ["TRANSFER", "transfer"],
    ["REFILL", "refill"],
    ["RX_UPLOAD", "upload"],
    ["MINOR_AILMENT", "ailment"],
    ["PHARMACIST_CHAT", null],
  ];
  for (const [intent, form] of forms) {
    const d = await ask("a message", intent);
    eq(`${intent} → form ${form}`, d.form, form);
  }

  const otc = await ask("do you carry vitamin d", "OTC_ORDER", { storeUrl: "https://example.test/shop" });
  eq("OTC_ORDER pushes no form", otc.form, null);
  check("OTC_ORDER reply carries the store link", otc.reply.includes("https://example.test/shop"));

  const otcNoStore = await ask("do you carry vitamin d", "OTC_ORDER");
  eq("OTC without a storefront goes to a person", otcNoStore.escalate, true);
  check(
    "OTC without a storefront leaves no hole in the reply",
    !/undefined|null|https?:/.test(otcNoStore.reply),
    otcNoStore.reply,
  );

  /* SMS vs web ─────────────────────────────────────────────────────── */

  const smsUpload = await ask("can i text you a picture of my script", "RX_UPLOAD", { channel: "sms" });
  eq("SMS pushes no form card", smsUpload.form, null);
  eq("SMS still says which form to link to", smsUpload.linkTo, "upload");
  check(
    "SMS upload reply explains that photos can't be texted",
    /don’t text the photo|can’t receive picture/i.test(smsUpload.reply),
    smsUpload.reply,
  );

  const webUpload = await ask("can i send you a picture of my script", "RX_UPLOAD", { channel: "web" });
  eq("web pushes the form card", webUpload.form, "upload");
  check(
    "web upload reply doesn't repeat the SMS-only warning",
    !/can’t receive picture/i.test(webUpload.reply),
    webUpload.reply,
  );

  for (const [intent] of forms) {
    for (const channel of ["web", "sms"] as const) {
      const d = await ask("a message", intent, { channel });
      check(
        `${intent}/${channel} reply stays under two SMS segments`,
        d.reply.length <= 300,
        `${d.reply.length} chars: ${d.reply}`,
      );
    }
  }

  /* Two strikes on UNCLEAR ─────────────────────────────────────────── */

  const first = await ask("I need help with something", "UNCLEAR");
  eq("first UNCLEAR asks rather than escalating", first.escalate, false);
  eq("first UNCLEAR uses the classifier's question", first.reply, "Is this a refill or something else?");

  const second = await ask("still not sure", "UNCLEAR", { prior: ["UNCLEAR"] });
  eq("second UNCLEAR in a row escalates", second.escalate, true);
  check("handoff reply doesn't ask a third question", !second.reply.includes("?"), second.reply);

  const afterAnswer = await ask("hmm", "UNCLEAR", { prior: ["UNCLEAR", "REFILL"] });
  eq("UNCLEAR after a resolved turn asks again", afterAnswer.escalate, false);

  const noQuestion = await ask("hm", "UNCLEAR", {
    classify: stub("UNCLEAR", { clarifying_question: null }),
  });
  check("a missing clarifying question still asks something", noQuestion.reply.includes("?"), noQuestion.reply);

  /* Replies never echo the message ─────────────────────────────────
     The whole reason reply copy is a template table: a reply is a function of
     the intent, never of what the patient wrote. Two very different messages
     landing on one intent must produce identical text — if they ever don't,
     something started interpolating the message, and the next thing it echoes
     is a diagnosis. */

  for (const [intent] of forms) {
    const a = await ask("running low on my blood pressure pills", intent);
    const b = await ask("hey its shane need my pills", intent);
    eq(`${intent} reply is identical for two different messages`, a.reply, b.reply);
  }

  const phi = await ask("I think I have a UTI and my eye is red", "MINOR_AILMENT", {
    classify: stub("MINOR_AILMENT", { contains_health_details: true }),
  });
  eq("health details are flagged", phi.containsHealthDetails, true);
  check(
    "a flagged message's reply repeats none of it",
    !/UTI|eye|red/i.test(phi.reply),
    phi.reply,
  );

  /* Degrading safely ───────────────────────────────────────────────── */

  const down = await respond("I need a refill", {
    classify: async () => { throw new Error("Anthropic API 503"); },
  });
  eq("a classifier outage routes to a human", down.escalate, true);
  eq("a classifier outage is marked degraded", down.degraded, true);
  eq("a classifier outage pushes no form", down.form, null);
  check("a classifier outage still answers the patient", down.reply.length > 0);

  const blank = await respond("   ", { classify: stub("REFILL") });
  eq("an empty message goes to a person", blank.escalate, true);
  check(
    "an attachment sent on its own gets a sensible reply",
    /pharmacist/i.test(blank.reply),
    blank.reply,
  );

  const long = await respond("x".repeat(MAX_MESSAGE_CHARS + 1), { classify: stub("REFILL") });
  eq("an over-length message goes to a person", long.escalate, true);
  eq("an over-length message pushes no form", long.form, null);

  /* Phone clause ───────────────────────────────────────────────────── */

  const withPhone = await ask("need to speak to the pharmacist", "PHARMACIST_CHAT", { phone: "555-0100" });
  check("the phone number is offered when configured", withPhone.reply.includes("555-0100"));

  const withoutPhone = await ask("need to speak to the pharmacist", "PHARMACIST_CHAT");
  check(
    "no placeholder leaks when no phone is configured",
    !/undefined|\[Phone/.test(withoutPhone.reply),
    withoutPhone.reply,
  );

  /* Report ─────────────────────────────────────────────────────────── */

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
