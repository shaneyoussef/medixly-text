/**
 * POST /api/chat — the chat client's one endpoint.
 *
 * The browser posts a message; this runs the agent and returns the decision.
 * The reason it exists at all is the API key: classification has to happen
 * somewhere the patient can't read, so the chat client never sees a key and
 * never talks to Anthropic directly.
 *
 * The same agent serves the SMS webhook. This is the web adapter, in the sense
 * docs/ARCHITECTURE.md means it — the cognition is in `agent.ts`, and this file
 * is HTTP plumbing plus an audit row.
 *
 * Conventions follow `submit.ts`: one handler, whitelisted input, BadRequest for
 * anything the caller can fix.
 */

import { createClient } from "@supabase/supabase-js";
import { respond, MAX_MESSAGE_CHARS, type Channel } from "./agent.js";

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // server-side only — never ship to the browser
);

const PHARMACY_ID = process.env.PHARMACY_ID ?? "medixly";

class BadRequest extends Error {
  constructor(public field: string, message: string) { super(message); }
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request" }, 400); }

  try {
    const message = String(body.message ?? "");
    if (!message.trim()) throw new BadRequest("message", "Nothing to send");
    if (message.length > MAX_MESSAGE_CHARS * 2) {
      // The agent routes an over-length message to a human, but there's no
      // reason to move megabytes to find that out.
      throw new BadRequest("message", "That message is too long to send");
    }

    const channel: Channel = body.channel === "sms" ? "sms" : "web";

    // Intent labels only. Anything that isn't a label is dropped rather than
    // trusted, and the history is capped so a caller can't grow it unboundedly.
    const prior = Array.isArray(body.prior)
      ? body.prior.filter((i: unknown) => typeof i === "string").slice(-6)
      : [];

    const pharmacy = await loadPharmacy();

    const decision = await respond(message, {
      channel,
      prior,
      phone: pharmacy?.phone,
      storeUrl: process.env.STORE_URL || undefined,
    });

    // PHIPA requires the custodian to account for every classification. The row
    // carries the decision and nothing the patient wrote — no message text, no
    // clarifying question, no reply body.
    const audit = await db.from("audit_log").insert({
      pharmacy_id: PHARMACY_ID,
      actor: "system",
      action: "classified",
      detail: {
        channel,
        intent: decision.intent,
        confidence: decision.confidence,
        contains_health_details: decision.containsHealthDetails,
        escalated: decision.escalate,
        emergency: decision.emergency,
        degraded: decision.degraded,
        form: decision.form ?? decision.linkTo,
      },
    });

    // An audit write failing must not cost the patient their reply — the reply
    // is already decided and goes out below — but it is not something to
    // swallow either.
    if (audit.error) console.error("[chat] audit write failed", audit.error);

    return json({
      intent: decision.intent,
      reply: decision.reply,
      form: decision.form,
      escalate: decision.escalate,
      emergency: decision.emergency,
      // Deliberately not returned: confidence and contains_health_details. They
      // drive retention and staff routing, not anything the browser decides,
      // and confidence in a response is a tuning signal handed to the public.
    }, 200);

  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message, field: e.field }, 400);
    console.error(e);
    return json({ error: "Something went wrong. Please call the pharmacy." }, 500);
  }
}

async function loadPharmacy() {
  const { data } = await db
    .from("pharmacies").select("phone").eq("id", PHARMACY_ID).maybeSingle();
  return data;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/* ── Before the pilot ─────────────────────────────────────────────────
   Rate limiting. This endpoint spends money on every call and there is
   nothing here stopping anyone from calling it in a loop. Per-session and
   per-IP limits belong in front of it, alongside the ones web/README.md
   already asks for on `submit`.

   Escalation has nowhere to land yet. `escalate: true` reaches the browser
   and stops there — the staff queue reads `requests`, and a chat turn isn't
   one. docs/ARCHITECTURE.md describes a `conversations` table that
   db/schema.sql doesn't have; that is the gap to close, and until it is, an
   escalated chat turn is only as visible as whoever is watching the chat.

   Conversation state is the client's. `prior` arrives in the request body, so
   a caller can send an empty history and get the clarifying question again
   instead of the handoff. It costs nothing worse than an extra question, but
   the two-strikes rule isn't enforceable until the history lives in a session
   row here.
─────────────────────────────────────────────────────────────────────── */
