/**
 * POST /api/submit — the only endpoint every form posts to.
 *
 * One handler for all six intents. Shared fields are validated the same way
 * every time; `payload` carries whatever that particular form collected.
 * Adding a seventh form means adding one entry to FORMS, nothing else.
 */

import { createClient } from "@supabase/supabase-js";
import { notify as sendSms, twilio, type Event } from "./notify.js";

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // server-side only — never ship to the browser
);

type Intent =
  | "REFILL" | "TRANSFER" | "RX_UPLOAD"
  | "MINOR_AILMENT" | "PHARMACIST_CHAT" | "OTC_ORDER";

/**
 * Per-intent config. `fields` are the payload keys this form may submit —
 * anything else is dropped rather than stored, so a tampered form can't
 * write arbitrary data.
 */
const FORMS: Record<Intent, {
  prefix: string;
  required: string[];
  fields: string[];
  urgent?: boolean;
}> = {
  TRANSFER:        { prefix: "TR", required: ["from_pharmacy"], fields: ["from_pharmacy", "scope", "notes"] },
  REFILL:          { prefix: "RF", required: [], fields: ["rx_numbers", "pickup_or_delivery", "notes"] },
  RX_UPLOAD:       { prefix: "UP", required: ["file_path"], fields: ["file_path", "prescriber", "notes"] },
  MINOR_AILMENT:   { prefix: "MA", required: ["condition"], fields: ["condition", "duration", "prior_treatment", "notes"], urgent: true },
  PHARMACIST_CHAT: { prefix: "PC", required: [], fields: ["topic", "best_time", "notes"], urgent: true },
  OTC_ORDER:       { prefix: "OT", required: ["items"], fields: ["items", "pickup_or_delivery", "notes"] },
};

const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — people read these aloud

function reference(prefix: string) {
  let s = "";
  for (let i = 0; i < 5; i++) s += REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)];
  return `${prefix}-${s}`;
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

class BadRequest extends Error {
  constructor(public field: string, message: string) { super(message); }
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request" }, 400); }

  try {
    const intent = body.intent as Intent;
    const form = FORMS[intent];
    if (!form) throw new BadRequest("intent", "Unknown request type");

    // --- consent gate: nothing is stored without it -----------------
    if (body.consent?.given !== true) {
      throw new BadRequest("consent", "Consent is required to submit a request");
    }

    // --- shared identity fields -------------------------------------
    const name = String(body.patient?.name ?? "").trim();
    if (name.length < 2) throw new BadRequest("name", "Please enter your name");

    const phone = digits(body.patient?.phone);
    if (phone.length !== 10) throw new BadRequest("phone", "Please enter a valid 10-digit phone number");

    const dob = body.patient?.dob ? String(body.patient.dob) : null;
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new BadRequest("dob", "Please enter a valid date of birth");
    }

    // --- form-specific payload, whitelisted -------------------------
    const payload: Record<string, unknown> = {};
    for (const key of form.fields) {
      const v = body.payload?.[key];
      if (v !== undefined && v !== null && v !== "") payload[key] = v;
    }
    for (const key of form.required) {
      if (payload[key] === undefined) throw new BadRequest(key, `${key.replace(/_/g, " ")} is required`);
    }

    // --- token check ------------------------------------------------
    // Links expire; an expired one means the patient should get a fresh
    // link rather than silently submitting against a stale request.
    const pharmacy_id = await resolvePharmacy(body.token, body.pharmacy_id);

    // --- insert -----------------------------------------------------
    const ref = reference(form.prefix);

    const { data, error } = await db.from("requests").insert({
      reference: ref,
      pharmacy_id,
      intent,
      channel: body.channel ?? "web",
      patient_name: name,
      patient_phone: phone,
      patient_dob: dob,
      payload,
      consent_given: true,
      consent_at: body.consent.at ?? new Date().toISOString(),
      consent_method: body.consent.method ?? "checkbox",
    }).select("id").single();

    if (error) throw error;

    await db.from("audit_log").insert({
      pharmacy_id, request_id: data.id, actor: "system",
      action: "created", detail: { intent, channel: body.channel ?? "web" },
    });

    // Notifications are fire-and-forget: an outage must not cost us the
    // request. The queue is the source of truth; mail and SMS are nudges.
    notify(pharmacy_id, ref, intent, name, form.urgent).catch(console.error);
    textPatient(pharmacy_id, phone, data.id, ref).catch(console.error);

    return json({ reference: ref, status: "received" }, 201);

  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message, field: e.field }, 400);
    console.error(e);
    return json({ error: "Something went wrong. Please call the pharmacy." }, 500);
  }
}

async function resolvePharmacy(token?: string, fallback?: string) {
  if (!token) {
    if (!fallback) throw new BadRequest("token", "This link is missing information");
    return fallback;
  }
  const { data } = await db
    .from("links")
    .select("pharmacy_id, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!data) throw new BadRequest("token", "This link is no longer valid — please request a new one");
  if (new Date(data.expires_at) < new Date()) {
    throw new BadRequest("token", "This link has expired — text us and we'll send a new one");
  }
  return data.pharmacy_id;
}

/**
 * Tell the patient we have their request.
 *
 * Two sends at most: the first-contact disclosure if this number has never
 * heard from us, then the receipt. Both are content-free — `api/notify.ts`
 * templates cannot carry a drug, a condition or anything from `payload`, and
 * `test/notify.ts` proves it.
 *
 * The intent is deliberately not passed. "We've got your refill request" would
 * put the kind of care on a lock screen, which is exactly what
 * docs/COMPLIANCE.md's no-PHI-over-SMS rule exists to prevent.
 */
async function textPatient(
  pharmacy_id: string, phone: string, request_id: string, reference: string,
) {
  const { data: pharmacy } = await db
    .from("pharmacies").select("name").eq("id", pharmacy_id).single();
  if (!pharmacy) return;

  // Consent and opt-out live on the phone number, not the request — saying STOP
  // once has to silence every future request too.
  const { data: existing } = await db
    .from("sms_contacts")
    .select("phone, opted_out, consent_at")
    .eq("phone", phone)
    .maybeSingle();

  const contact = {
    phone,
    optedOut: existing?.opted_out === true,
    consentAt: existing?.consent_at ?? null,
  };
  if (contact.optedOut) return;

  const sender = twilio();
  const ctx = {
    pharmacy: pharmacy.name,
    reference,
    link: process.env.CHAT_URL ?? "",
  };

  const log = (event: Event, outcome: string, provider_id?: string) =>
    db.from("sms_log").insert({
      pharmacy_id, phone, request_id, event, outcome, provider_id,
    });

  // First contact gets the disclosure before anything else, per the controls
  // checklist in docs/COMPLIANCE.md.
  if (!contact.consentAt) {
    const first = await sendSms(contact, "consent", ctx, sender);
    await log("consent", first.sent ? "sent" : first.reason ?? "failed");
    if (!first.sent) return;                  // don't stack a second text on a failure
    await db.from("sms_contacts").upsert({
      phone, pharmacy_id, consent_at: new Date().toISOString(),
    });
  }

  const receipt = await sendSms(contact, "received", ctx, sender);
  await log("received", receipt.sent ? "sent" : receipt.reason ?? "failed");
}

/**
 * Notify the pharmacy. Deliberately contains NO patient detail beyond a first
 * name and the request type — the email is a pointer to the queue, not a copy
 * of the record. Keeps PHI out of inboxes we don't control.
 */
async function notify(
  pharmacy_id: string, ref: string, intent: Intent,
  name: string, urgent = false,
) {
  const { data: pharmacy } = await db
    .from("pharmacies").select("notify_email").eq("id", pharmacy_id).single();
  if (!pharmacy) return;

  const label = intent.replace(/_/g, " ").toLowerCase();
  const first = name.split(/\s+/)[0];

  await sendMail({
    to: pharmacy.notify_email,
    subject: `${urgent ? "[Needs pharmacist] " : ""}New ${label} request — ${ref}`,
    text:
      `A new ${label} request came in from ${first}.\n\n` +
      `Reference: ${ref}\n` +
      `Open the queue to see the details:\n` +
      `${process.env.APP_URL}/queue/${ref}\n\n` +
      `Patient details are not included in this email by design.`,
  });
}

// Swap for Hushmail/SES. Kept behind one function so the provider can change
// without touching the handler.
async function sendMail(_msg: { to: string; subject: string; text: string }) {
  throw new Error("sendMail not wired up yet");
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}
