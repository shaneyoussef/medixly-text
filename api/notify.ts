/**
 * Patient SMS notifications.
 *
 * One rule governs this whole file, and it is the same rule the rest of the
 * architecture rests on (`docs/COMPLIANCE.md`):
 *
 *   **No PHI over SMS.**
 *
 * So a notification never names a drug, a dose, a condition, a prescriber, or
 * what a request was for. It says the pharmacy has news and where to read it.
 * The detail lives behind sign-in, in the secure chat, which is the entire
 * reason that chat exists.
 *
 * Templates are static strings. The only things interpolated are the pharmacy
 * name, a reference code, and a link — never a value that came from a patient or
 * from a form payload. `test/notify.ts` asserts that mechanically, because a
 * reviewer reading this comment is a weaker guarantee than a test.
 *
 * One disclosure is unavoidable and worth naming rather than glossing: a text
 * from a pharmacy tells anyone who sees the lock screen that this person is a
 * patient of it. `docs/PIA.md` §3 is clear that the fact of receiving care is
 * itself PHI. Texting a patient at all accepts that; what this file refuses is
 * everything beyond it.
 */

export const EVENTS = [
  "received",       // a request landed in the queue
  "ready",          // something is ready to collect
  "message",        // a pharmacist replied in the chat
  "action_needed",  // the pharmacy needs something before it can proceed
  "consent",        // first contact: the disclosure and how to opt out
] as const;

export type Event = (typeof EVENTS)[number];

export interface Contact {
  phone: string;          // ten digits, as stored
  optedOut: boolean;
  consentAt: string | null;
}

export interface Message {
  to: string;
  body: string;
}

/** Two segments. Beyond this the carrier splits and the cost doubles. */
export const MAX_CHARS = 300;

/**
 * Every message a patient can receive.
 *
 * Read these as the complete list of what SMS is allowed to say. Adding an
 * entry is a compliance decision, not a copy decision: if a new template needs
 * a value out of a form payload to make sense, that is the signal it belongs in
 * the chat instead.
 */
const TEMPLATE: Record<Event, (ctx: Ctx) => string> = {
  consent: (c) =>
    `${c.pharmacy}: we'll text you about your requests. Texts are not secure, so please don't reply with health details — use ${c.link} instead. Reply STOP to opt out.`,

  received: (c) =>
    `${c.pharmacy}: we've got your request (${c.reference}). We'll text you when there's news. Reply STOP to opt out.`,

  ready: (c) =>
    `${c.pharmacy}: your order is ready to collect. Reference ${c.reference}. Reply STOP to opt out.`,

  message: (c) =>
    `${c.pharmacy}: you have a new message from the pharmacy. Read it at ${c.link}. Reply STOP to opt out.`,

  action_needed: (c) =>
    `${c.pharmacy}: we need one more thing before we can finish request ${c.reference}. Open ${c.link} to see what.`,
};

interface Ctx {
  pharmacy: string;
  reference: string;
  link: string;
}

/**
 * Build the message for an event. Exported so the tests can read every template
 * without a database or a carrier.
 */
export function compose(event: Event, ctx: Ctx): string {
  const build = TEMPLATE[event];
  if (!build) throw new Error(`unknown notification event: ${event}`);
  return build(ctx);
}

/* ── Sending ───────────────────────────────────────────────────────────
   The carrier sits behind one function so it can be swapped without
   touching anything above. Twilio today; the shape is a phone number and
   a string, which every provider takes.
   ─────────────────────────────────────────────────────────────────── */

export interface Sender {
  send(msg: Message): Promise<{ id: string }>;
}

export function twilio(): Sender {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM ?? "";

  return {
    async send(msg) {
      if (!sid || !token || !from) {
        throw new Error("Twilio is not configured");
      }
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: "Basic " + btoa(`${sid}:${token}`),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: msg.to, From: from, Body: msg.body }),
        },
      );
      if (!res.ok) {
        // Status only. A carrier error body can echo the message back, and the
        // audit trail deliberately holds no message text.
        throw new Error(`Twilio ${res.status}`);
      }
      const data = await res.json();
      return { id: data.sid };
    },
  };
}

export interface NotifyResult {
  sent: boolean;
  reason?: "opted_out" | "no_phone" | "not_configured" | "failed" | "too_long";
}

/**
 * Send one notification, or decline to and say why.
 *
 * Never throws. A carrier outage must not roll back the thing that triggered
 * the notification — the request is already in the queue, and a pharmacist
 * working from the queue is the actual delivery mechanism. SMS is a nudge.
 */
export async function notify(
  contact: Contact,
  event: Event,
  ctx: Ctx,
  sender: Sender,
): Promise<NotifyResult> {
  if (!contact.phone || !/^\d{10}$/.test(contact.phone)) {
    return { sent: false, reason: "no_phone" };
  }

  // Opt-out is checked here, before anything is composed, so there is no path
  // that formats a message for someone who has said stop.
  if (contact.optedOut) return { sent: false, reason: "opted_out" };

  const body = compose(event, ctx);
  if (body.length > MAX_CHARS) {
    // A template got edited past two segments. Better to notice than to pay for
    // it silently on every send.
    console.error(`[notify] "${event}" template is ${body.length} chars, over ${MAX_CHARS}`);
    return { sent: false, reason: "too_long" };
  }

  try {
    await sender.send({ to: `+1${contact.phone}`, body });
    return { sent: true };
  } catch (err) {
    console.error(`[notify] "${event}" failed:`, (err as Error)?.message);
    return { sent: false, reason: "failed" };
  }
}

/**
 * A patient texted STOP. Recognised broadly because people write it however
 * they like, and getting this wrong means texting someone who asked you not to.
 *
 * Twilio also handles STOP at the carrier level on toll-free and A2P numbers,
 * so this is the second of two gates rather than the only one — but the
 * pharmacy still has to be able to account for the opt-out itself.
 */
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt\s*out|no more)\s*[.!]?\s*$/i;
export const isOptOut = (body: string) => STOP_WORDS.test(String(body ?? ""));

/** And the way back in. */
const START_WORDS = /^\s*(start|unstop|yes|resume|subscribe)\s*[.!]?\s*$/i;
export const isOptIn = (body: string) => START_WORDS.test(String(body ?? ""));

/* ── Before the pilot ─────────────────────────────────────────────────
   Toll-free verification is mandatory before a single send — see
   docs/COMPLIANCE.md. Nothing here works without it.

   There is no inbound webhook yet. STOP arrives as an inbound SMS, and
   until `api/webhook.ts` exists and writes `sms_contacts.opted_out`, the
   only opt-out gate is Twilio's own. That is not enough for a custodian
   that has to account for its own consent records.

   Rate limiting, and a cap on how many texts one patient can get in a day.
   A loop in the queue software should not become a hundred texts.
─────────────────────────────────────────────────────────────────────── */
