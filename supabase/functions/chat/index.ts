/**
 * /functions/v1/chat — two-way messaging between a patient and a pharmacist.
 *
 * SMS is the front door and carries no health information. This channel does:
 * it is where a patient answers "what are your symptoms". It lives in
 * ca-central-1, every message body is encrypted with a key this database does
 * not hold, and every read and write is audited.
 *
 * ── What "encrypted" means here, precisely ──────────────────────────────
 *
 * In transit: TLS, terminated by Supabase.
 * At rest:    AES-256-GCM over the message body, in this function, with a key
 *             held as a function secret. A stolen database dump, a leaked
 *             backup, or anyone with table access gets ciphertext.
 *
 * It is **not** end-to-end encryption and must never be described as such.
 * The pharmacy can read these messages, and has to be able to: PHIPA makes
 * Medixly the health information custodian, which means retaining the record,
 * producing it on an access request, and letting whichever pharmacist is on
 * duty answer. A scheme where the server cannot read would trade all of that
 * for a property a custodian is not allowed to have — and one lost device
 * would be one destroyed medical record.
 *
 * Two callers, two auth models:
 *   Patient    — ?t=<chat_token>. No login; the token is the credential, so it
 *                expires and is scoped to exactly one request.
 *   Pharmacist — x-staff-key header. Pilot-grade; replace with per-person auth
 *                before the pilot, because a shared key cannot answer PHIPA
 *                s.10(1)'s question of *who* read a record.
 *
 * Routes:
 *   GET  ?t=token                          → patient reads their thread
 *   POST ?t=token   { body }               → patient sends
 *   GET  ?reference=TR-XXXXX               → staff reads (marks patient msgs read)
 *   POST ?reference=TR-XXXXX { body }      → staff sends
 *   POST ?reference=TR-XXXXX { open:true } → staff opens/renews the patient link
 *   POST ?reference=TR-XXXXX { revoke:true }→ staff kills the link now
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseKeys, seal, openAll } from "./crypto.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/* ── Secrets ───────────────────────────────────────────────────────────
   No fallbacks. A previous version of this file carried a default staff key
   in its source, which meant the only gate on the staff side of every patient
   thread was a string anybody who could read the function could read too.
   Missing configuration now fails closed and says so in the logs.

   MESSAGE_KEYS is `id:base64key` entries, comma separated, newest first:

     k2:Base64Of32Bytes,k1:Base64Of32Bytes

   The first entry encrypts. Every entry can decrypt, which is what makes
   rotation possible without rewriting history — each message names the key
   that opened it. Generate one with:

     openssl rand -base64 32
   ─────────────────────────────────────────────────────────────────── */
const STAFF_KEY = Deno.env.get("STAFF_KEY") ?? "";
const RAW_KEYS = Deno.env.get("MESSAGE_KEYS") ?? "";
const CHAT_URL = Deno.env.get("CHAT_URL") ?? "https://medixly.ca/chat/";
const TOKEN_DAYS = 14;
const MAX_BODY = 4000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, x-staff-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

/* ── Encryption ────────────────────────────────────────────────────────
   The scheme itself is in crypto.ts, so that test/crypto.ts can exercise the
   same code this function runs rather than a copy of it. Parsed once at boot,
   which turns a malformed secret into a startup log line instead of a 3am
   mystery.
   ─────────────────────────────────────────────────────────────────── */
const KEYS = await parseKeys(RAW_KEYS);

/* ── Bits and pieces ───────────────────────────────────────────────── */

// Unambiguous alphabet — tokens end up in URLs patients sometimes read aloud.
const TOKEN_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
function newToken(len = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join("");
}

/** Constant time, so the staff key cannot be recovered a byte at a time. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function audit(
  pharmacy_id: string, request_id: string,
  actor: string, action: string, detail?: Record<string, unknown>,
) {
  // Never the message body. The log records that a thing happened, not what
  // was said — an audit trail full of PHI is a second copy to protect.
  await db.from("audit_log").insert({ pharmacy_id, request_id, actor, action, detail });
}

function cleanBody(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > MAX_BODY) return null;
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Fail closed rather than quietly writing plaintext into a column whose
  // whole purpose is that it holds none.
  if (!KEYS.current) return json({ error: "Messaging is not configured." }, 503);
  if (!STAFF_KEY) return json({ error: "Messaging is not configured." }, 503);

  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const reference = url.searchParams.get("reference");
  const isStaff = sameSecret(req.headers.get("x-staff-key") ?? "", STAFF_KEY);

  /* ── Patient side — token only ──────────────────────────────────── */
  if (token) {
    const { data: request } = await db
      .from("requests")
      .select("id, pharmacy_id, reference, patient_name, chat_expires_at, status")
      .eq("chat_token", token)
      .maybeSingle();

    // One message for "no such token" and "expired token" would be kinder to
    // an attacker than to a patient; the split is deliberate, and neither says
    // anything about who the request belongs to.
    if (!request) return json({ error: "This link is not valid." }, 404);
    if (!request.chat_expires_at || new Date(request.chat_expires_at) < new Date()) {
      return json({ error: "This conversation has expired. Please contact the pharmacy for a new link." }, 410);
    }

    if (req.method === "GET") {
      const { data: messages } = await db
        .from("messages")
        .select("id, sender, author, body, created_at, read_at")
        .eq("request_id", request.id)
        .order("created_at", { ascending: true });

      return json({
        reference: request.reference,
        patient_name: request.patient_name,
        closed: ["completed", "cancelled"].includes(request.status),
        messages: await openAll(KEYS, messages ?? []),
      });
    }

    if (req.method === "POST") {
      let payload: Record<string, unknown>;
      try { payload = await req.json(); } catch { return json({ error: "Malformed request" }, 400); }

      const body = cleanBody(payload.body);
      if (!body) return json({ error: "Please write a message." }, 400);

      const { data: row, error } = await db.from("messages").insert({
        request_id: request.id,
        pharmacy_id: request.pharmacy_id,
        sender: "patient",
        body: await seal(KEYS, body),
      }).select("id, created_at").single();
      if (error) { console.error(error); return json({ error: "Could not send that message." }, 500); }

      // A patient replying to a closed thread reopens it — otherwise their
      // message lands somewhere nobody is looking.
      if (["completed", "cancelled"].includes(request.status)) {
        await db.from("requests").update({ status: "new", completed_at: null }).eq("id", request.id);
      }

      await audit(request.pharmacy_id, request.id, "patient", "message_sent");
      return json({ ok: true, id: row.id, created_at: row.created_at }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  /* ── Staff side — key required ──────────────────────────────────── */
  if (!isStaff) return json({ error: "Not authorized" }, 401);
  if (!reference) return json({ error: "reference required" }, 400);

  const { data: request } = await db
    .from("requests")
    .select("id, pharmacy_id, reference, patient_name, patient_phone, chat_token, chat_expires_at")
    .eq("reference", reference)
    .maybeSingle();

  if (!request) return json({ error: "No such request" }, 404);

  const linkIfLive = () =>
    request.chat_token && request.chat_expires_at &&
    new Date(request.chat_expires_at) > new Date()
      ? { link: `${CHAT_URL}?t=${request.chat_token}`, expires_at: request.chat_expires_at }
      : { link: null, expires_at: null };

  if (req.method === "GET") {
    const { data: messages } = await db
      .from("messages")
      .select("id, sender, author, body, created_at, read_at")
      .eq("request_id", request.id)
      .order("created_at", { ascending: true });

    // Mark the patient's messages read now that staff have them on screen.
    const unread = (messages ?? []).filter((m) => m.sender === "patient" && !m.read_at);
    if (unread.length) {
      await db.from("messages")
        .update({ read_at: new Date().toISOString() })
        .in("id", unread.map((m) => m.id));
    }

    await audit(request.pharmacy_id, request.id, "staff", "viewed", {
      view: "chat", messages: messages?.length ?? 0,
    });

    return json({
      reference: request.reference,
      patient_name: request.patient_name,
      patient_phone: request.patient_phone,
      messages: await openAll(KEYS, messages ?? []),
      ...linkIfLive(),
    });
  }

  if (req.method === "POST") {
    let payload: Record<string, unknown>;
    try { payload = await req.json(); } catch { return json({ error: "Malformed request" }, 400); }

    // Open or renew the patient's way in.
    if (payload.open === true) {
      const chat_token = request.chat_token ?? newToken();
      const expires = new Date(Date.now() + TOKEN_DAYS * 864e5).toISOString();

      const { error } = await db.from("requests")
        .update({ chat_token, chat_expires_at: expires }).eq("id", request.id);
      if (error) { console.error(error); return json({ error: "Could not open the chat." }, 500); }

      await audit(request.pharmacy_id, request.id, "staff", "chat_opened", { expires });
      return json({ link: `${CHAT_URL}?t=${chat_token}`, expires_at: expires }, 201);
    }

    // Revoke immediately — needed the moment a link reaches the wrong person.
    if (payload.revoke === true) {
      await db.from("requests")
        .update({ chat_token: null, chat_expires_at: null }).eq("id", request.id);
      await audit(request.pharmacy_id, request.id, "staff", "chat_revoked");
      return json({ ok: true });
    }

    const body = cleanBody(payload.body);
    if (!body) return json({ error: "Please write a message." }, 400);

    const { data: row, error } = await db.from("messages").insert({
      request_id: request.id,
      pharmacy_id: request.pharmacy_id,
      sender: "pharmacist",
      author: String(payload.author ?? "staff").slice(0, 80),
      body: await seal(KEYS, body),
    }).select("id, created_at").single();
    if (error) { console.error(error); return json({ error: "Could not send that message." }, 500); }

    await audit(request.pharmacy_id, request.id, "staff", "message_sent");
    return json({ ok: true, id: row.id, created_at: row.created_at }, 201);
  }

  return json({ error: "Method not allowed" }, 405);
});

/* ══════════════════════════════════════════════════════════════════════
   Still outstanding, in the order they block a pilot.

   1. Per-person staff auth. `x-staff-key` is one shared secret, so the audit
      log records "staff" and PHIPA s.10(1) asks *which* staff. This is the
      open item that blocks the pilot, not a nice-to-have. Risk 1 in
      docs/PIA.md.
   2. No rate limit on either side. The patient route is unauthenticated by
      design — the token is the credential — so a leaked token can be
      hammered, and the staff route can be brute-forced. Both want a limit
      per token, per key and per IP.
   3. The staff key belongs in a password manager, not in a browser tab. It
      is typed into the queue page and lives in localStorage; anyone with the
      device has it.
   4. Key rotation is supported but unscheduled. Add a key to the front of
      MESSAGE_KEYS, leave the old one behind it, and old messages keep
      opening. Nothing rewrites history, so the old key can never be dropped
      until those messages are purged.
   ═══════════════════════════════════════════════════════════════════ */
