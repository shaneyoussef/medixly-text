/**
 * The agent layer — one patient message in, one routing decision out.
 *
 * `classify.ts` says *what* a message is. This says *what to do about it*: which
 * reply the patient sees, which form they get, and whether a human has to look
 * at it now. Same split as the classifier: no database, no Twilio, no fetch of
 * its own, so a decision is a pure function of a message plus a little history
 * and can be tested without an API key (see `test/agent.ts`).
 *
 * It is a router, not a chatbot. It never asks for medication names, symptoms,
 * diagnoses or health card numbers, never answers a clinical question, and never
 * quotes the patient's message back at them. All of that is deliberate: the
 * architecture keeps PHI inside the forms and the database, and clinical
 * judgment with the pharmacist. An agent that chatted its way to an answer would
 * undo both.
 */

import {
  classify as liveClassify,
  type Classification,
  type Intent,
} from "./classify.js";

/** The chat client's form card ids, from `secure-chat.forms.js`. */
export type FormId = "transfer" | "refill" | "upload" | "ailment" | "callback";

/** Matches the `request_channel` enum in `db/schema.sql`. */
export type Channel = "sms" | "web";

export interface AgentDecision {
  intent: Intent;
  confidence: number;
  /** Drives shortened retention. Never affects the reply text. */
  containsHealthDetails: boolean;
  /** What the patient sees. Drawn from a template — never from their message. */
  reply: string;
  /** Form card to push into the thread. Web chat only; null on SMS. */
  form: FormId | null;
  /**
   * A product search to run, or null. Only ever set for a shopping request the
   * classifier found no health details in — see the refusal boundary below.
   */
  shopQuery: string | null;
  /** Which form the tokenized link should point at. SMS uses this; web ignores it. */
  linkTo: FormId | null;
  /** A person needs to see this now. */
  escalate: boolean;
  /** The emergency tripwire fired, so no classification was attempted. */
  emergency: boolean;
  /** The classifier was unreachable and the message was routed to a human. */
  degraded: boolean;
}

export interface AgentContext {
  channel?: Channel;
  /**
   * Prior turns, oldest first — intent labels only, never message text. Used
   * for the two-strikes rule below. Keeping it to labels means conversation
   * state carries no health information, so it can live in a cookie, a client,
   * or a session row without becoming a retention problem.
   */
  prior?: Intent[];
  /** Voice line, shown when we tell someone to call. Clause is dropped if unset. */
  phone?: string;
  /** The OTC storefront, for channels with no in-chat shop (SMS). */
  storeUrl?: string;
  /** True when the surface can show product cards — the web chat can. */
  shop?: boolean;
  /** Swap the classifier out in tests. */
  classify?: (message: string) => Promise<Classification>;
}

/** Longer than this and we don't spend a classification on it. */
export const MAX_MESSAGE_CHARS = 2000;

/* ── The emergency tripwire ────────────────────────────────────────────
   Deterministic, and it runs *before* the classifier, because the one reply
   that must never depend on an LLM call succeeding is "call 911". If the
   Anthropic API is down or slow, chest pain still gets an answer.

   The four categories are taken verbatim from the emergency rule in
   `classify.ts`'s system prompt — they are not new clinical content. The
   classifier's own convention for these (PHARMACIST_CHAT at confidence 1.0)
   is not usable as a signal: an ordinary confident message returns 1.0 too.

   A keyword list cannot be complete, and this one is not a triage protocol.
   Two things carry that weight instead: the standing notice in the chat UI
   ("Don't send emergency requests here — call us or dial 911"), which shows
   even when the network is gone, and the pharmacy's sign-off on this list
   before the pilot. See docs/AGENT.md.

   Apostrophes are matched as either ASCII or typographic — phone keyboards
   autocorrect "cant" to "can’t", and a pattern that only knew about ' would
   miss most real messages.
   ─────────────────────────────────────────────────────────────────── */
export const EMERGENCY_PATTERNS: RegExp[] = [
  /\bchest (pain|pains|pressure|tightness)\b/i,
  /\b(trouble|difficulty|struggling|problems?) breathing\b/i,
  /\b(can['’]?t|cannot|could ?n['’]?t) breathe\b/i,
  /\bshort(ness)? of breath\b/i,
  /\b(severe|heavy|bad|won['’]?t stop) bleeding\b/i,
  /\bbleeding (a lot|badly|everywhere|non ?stop|won['’]?t stop)\b/i,
  /\b(kill|harm|hurt)(ing|s)? (myself|my ?self)\b/i,
  /\b(end|take)(ing)? my (own )?life\b/i,
  /\bself[- ]harm/i,
  /\bsuicidal\b/i,
];

export const isEmergency = (message: string) =>
  EMERGENCY_PATTERNS.some((re) => re.test(message));

/* ── Intent → form ────────────────────────────────────────────────────
   PHARMACIST_CHAT and OTC_ORDER have no form card: one needs a person, the
   other is a storefront. UNCLEAR asks a question instead.

   The chat client also has a `vaccine` card, and the classifier has no intent
   that reaches it — it is only reachable from the service rail. That gap is
   real and stays open until the pharmacy decides whether vaccines are an
   intent; see docs/AGENT.md.
   ─────────────────────────────────────────────────────────────────── */
const FORM_FOR: Partial<Record<Intent, FormId>> = {
  TRANSFER: "transfer",
  REFILL: "refill",
  RX_UPLOAD: "upload",
  MINOR_AILMENT: "ailment",
  PHARMACIST_CHAT: "callback",
};

/* ── The refusal boundary ──────────────────────────────────────────────
   An agent that answers "what should I take for my UTI" with a product is
   giving clinical advice. It must not, ever — that judgment belongs to a
   pharmacist, and this is the line that keeps a shop inside a pharmacy
   lawful rather than merely convenient.

   The boundary is drawn on a signal the classifier already computes:
   `contains_health_details`. A shopping request with no health details in
   it ("do you have Claritin", "nasal strips") is a product lookup, and
   safe. A shopping request that mentions a symptom ("something for my
   itchy eyes") is a clinical question wearing a shopping hat, and gets a
   pharmacist instead of a shelf.

   Note what this makes load-bearing. `docs/CLASSIFIER.md` describes PHI
   detection as driving shortened retention; it now also draws a clinical
   safety line, so a miss on that flag is no longer only a privacy problem.
   The separate PHI-detection score in `test/run.ts` is the number to watch.
   ─────────────────────────────────────────────────────────────────── */

/* ── Reply copy ───────────────────────────────────────────────────────
   Templates, not generated text. A reply is a function of the *intent*, never
   of the message, which is what guarantees no health detail is ever echoed
   back — see the test that asserts two different messages with the same intent
   get byte-identical replies.

   Kept under ~300 characters (two SMS segments) so the same copy works on both
   channels. Sentence case, no emoji, per the design rules in web/HANDOFF.md.
   ─────────────────────────────────────────────────────────────────── */
const REPLY: Record<Exclude<Intent, "UNCLEAR">, Record<Channel, string>> = {
  TRANSFER: {
    web: "Happy to help you move your prescriptions over. Fill this in and we’ll get straight onto it.",
    sms: "Happy to help you move your prescriptions over. Start here and we’ll take it from there:",
  },
  REFILL: {
    web: "Let’s get that refill started. Fill this in and we’ll message you here as soon as it’s ready.",
    sms: "Let’s get that refill started. Fill this in and we’ll text you when it’s ready:",
  },
  RX_UPLOAD: {
    web: "You can send us the prescription right here. Add a photo or a PDF below and a pharmacist will review it.",
    // MMS is deliberately off, so a texted photo silently fails. Say why.
    sms: "Please don’t text the photo — we can’t receive picture messages. Send it through this secure link instead:",
  },
  MINOR_AILMENT: {
    web: "A pharmacist can assess this. Fill in this short assessment and they’ll review it and message you here.",
    sms: "A pharmacist can assess this. Fill in this short assessment and they’ll get back to you:",
  },
  PHARMACIST_CHAT: {
    web: "This one’s for a pharmacist. I’ve flagged it and they’ll reply here.",
    sms: "This one’s for a pharmacist. I’ve flagged it and they’ll get back to you.",
  },
  OTC_ORDER: {
    web: "Here’s what we have on the shelf. A pharmacist checks every order before it goes out.",
    sms: "You can browse and order those here:",
  },
};

/**
 * A shopping message that mentions a symptom. Not refused — redirected, because
 * the patient asked a reasonable question and deserves a better answer than a
 * product listing.
 */
const OTC_CLINICAL =
  "I’d rather a pharmacist answered that than have me point you at a shelf. Tell them what’s going on and they’ll say what will actually help.";

/** Second UNCLEAR in a row: stop asking and get a person. */
const HANDOFF =
  "I’m not sure I’ve got this right, so I’ve passed it to the team. Someone will reply here.";

/** The classifier was unreachable. The message is never dropped. */
const DEGRADED =
  "Thanks — I’ve passed this to the team and someone will reply here.";

const OTC_NO_STORE =
  "Our team can help you with that. I’ve passed it along and they’ll reply here.";

const EMERGENCY =
  "If this is an emergency, call 911 or go to your nearest emergency department now. Don’t wait for a reply here.";

const TOO_LONG =
  "That’s a long one — I’ve passed it to the team so a person can read it properly. They’ll reply here.";

/**
 * No text to classify. Usually a photo of a prescription sent on its own, which
 * is a normal thing to do and needs a pharmacist rather than a guess.
 */
const NO_TEXT =
  "Thanks — a pharmacist will take a look and reply here.";

/** "… If it's urgent, call us at 555-0100." Dropped when no phone is configured. */
const urgentCall = (phone?: string) =>
  phone ? ` If it’s urgent, call us at ${phone}.` : "";

/**
 * Decide what to do with one patient message.
 *
 * Never throws: a classifier outage degrades to a human handoff rather than
 * losing the message. Silently dropping a patient request is the one failure
 * mode this system cannot have.
 */
export async function respond(
  message: string,
  ctx: AgentContext = {},
): Promise<AgentDecision> {
  const channel: Channel = ctx.channel ?? "web";
  const text = String(message ?? "");

  const base = {
    confidence: 0,
    containsHealthDetails: false,
    form: null,
    linkTo: null,
    shopQuery: null,
    emergency: false,
    degraded: false,
  } as const;

  // 1. Emergency, before anything that can fail or stall.
  if (isEmergency(text)) {
    return {
      ...base,
      intent: "PHARMACIST_CHAT",
      confidence: 1,
      containsHealthDetails: true,
      // No "or call us" clause here on purpose. The instruction is 911, and a
      // second number to try is a reason to hesitate.
      reply: EMERGENCY,
      escalate: true,
      emergency: true,
    };
  }

  // 2. Nothing to classify, or too much of it. Either way, a person.
  if (!text.trim()) {
    return { ...base, intent: "UNCLEAR", reply: NO_TEXT, escalate: true };
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ...base, intent: "UNCLEAR", reply: TOO_LONG, escalate: true };
  }

  // 3. Classify.
  const run = ctx.classify ?? ((m: string) => liveClassify(m));
  let found: Classification;
  try {
    found = await run(text);
  } catch (err) {
    // The message itself is never logged, only what went wrong reaching the
    // classifier.
    console.error("[agent] classification failed:", (err as Error)?.message);
    return {
      ...base,
      intent: "UNCLEAR",
      reply: DEGRADED + urgentCall(ctx.phone),
      escalate: true,
      degraded: true,
    };
  }

  const shared = {
    confidence: found.confidence,
    containsHealthDetails: found.contains_health_details,
    shopQuery: null,
    emergency: false,
    degraded: false,
  };

  // 4. UNCLEAR — one clarifying question, then a person. Two of these in a row
  //    means the agent is guessing, and guessing on a health request is the
  //    behaviour we're trying to avoid.
  if (found.intent === "UNCLEAR") {
    const askedAlready = (ctx.prior ?? []).at(-1) === "UNCLEAR";
    if (askedAlready) {
      return {
        ...shared,
        intent: "UNCLEAR",
        reply: HANDOFF + urgentCall(ctx.phone),
        form: null,
        linkTo: null,
        escalate: true,
      };
    }
    return {
      ...shared,
      intent: "UNCLEAR",
      // The classifier writes this one, under a prompt rule that forbids it
      // from repeating any health detail.
      reply:
        found.clarifying_question ??
        "Happy to help — is this about a prescription, a health concern, or an over-the-counter product?",
      form: null,
      linkTo: null,
      escalate: false,
    };
  }

  // 5. Shopping. The refusal boundary above decides which of three ways this
  //    goes, and the order matters: clinical first, then whether we can sell.
  if (found.intent === "OTC_ORDER") {
    // A symptom in a shopping message is a clinical question. No shelf.
    if (found.contains_health_details) {
      return {
        ...shared,
        intent: "OTC_ORDER",
        reply: OTC_CLINICAL,
        form: channel === "web" ? "callback" : null,
        linkTo: "callback",
        escalate: true,
      };
    }

    // In-chat shop, on web: search the shelf.
    if (channel === "web" && ctx.shop) {
      return {
        ...shared,
        intent: "OTC_ORDER",
        reply: REPLY.OTC_ORDER.web,
        form: null,
        linkTo: null,
        shopQuery: text,
        escalate: false,
      };
    }

    // SMS, or web with no shop wired: a link if there is one, a person if not.
    if (!ctx.storeUrl) {
      return {
        ...shared,
        intent: "OTC_ORDER",
        reply: OTC_NO_STORE,
        form: null,
        linkTo: null,
        escalate: true,
      };
    }
    return {
      ...shared,
      intent: "OTC_ORDER",
      reply: `${REPLY.OTC_ORDER[channel]} ${ctx.storeUrl}`,
      form: null,
      linkTo: null,
      escalate: false,
    };
  }

  const form = FORM_FOR[found.intent] ?? null;
  let reply = REPLY[found.intent][channel];
  if (found.intent === "PHARMACIST_CHAT") reply += urgentCall(ctx.phone);

  return {
    ...shared,
    intent: found.intent,
    reply,
    // On SMS the reply carries a tokenized link instead of a card; the link
    // service builds the URL from `linkTo`.
    form: channel === "web" ? form : null,
    linkTo: form,
    escalate: found.intent === "PHARMACIST_CHAT",
  };
}
