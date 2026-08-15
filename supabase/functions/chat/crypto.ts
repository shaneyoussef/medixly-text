/**
 * Message body encryption for the patient/pharmacist channel.
 *
 * Split out of index.ts for one reason: so `test/crypto.ts` can exercise the
 * real thing. A copy of this logic living in a test file would pass happily
 * while the deployed function drifted away from it.
 *
 * Nothing here touches Deno APIs — it is WebCrypto and nothing else — which is
 * what lets the same file run in the edge function and under `tsx` in CI.
 *
 * ── What this is, and is not ───────────────────────────────────────────
 *
 * AES-256-GCM over the message body, keyed by a secret the database does not
 * hold. A stolen dump, a leaked backup or a support engineer with table access
 * gets ciphertext.
 *
 * It is **not** end-to-end encryption. The pharmacy can read these messages
 * and must be able to: PHIPA makes Medixly the custodian, which means keeping
 * the record, producing it on an access request, and letting whichever
 * pharmacist is on duty answer. See the header of index.ts.
 */

/** Envelope: `mx1.<key id>.<base64url iv>.<base64url ciphertext+tag>` */
const PREFIX = "mx1";

/** Written by the retention job, which blanks bodies but keeps the row. */
export const PURGED = "purged";

export const NOTE_NO_KEY = "[unreadable — encryption key not available]";
export const NOTE_TAMPERED = "[unreadable — this message failed its integrity check]";
export const NOTE_PURGED = "[removed under the retention policy]";

export const b64u = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(
      atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")),
      (c) => c.charCodeAt(0),
    );
  },
};

export interface Keyring {
  /** Every key that can decrypt, by id. */
  map: Map<string, CryptoKey>;
  /** The id that encrypts — the first usable entry. Null means closed. */
  current: string | null;
}

/**
 * Parses `id:base64key` entries, comma separated, newest first:
 *
 *   k2:Base64Of32Bytes,k1:Base64Of32Bytes
 *
 * The first usable entry encrypts; every entry can decrypt. That asymmetry is
 * the whole rotation story — add a key at the front, leave the old one behind
 * it, and history keeps opening because each message names the key that
 * sealed it. Nothing rewrites old rows, so an old key can only be dropped once
 * the messages under it have been purged.
 *
 * Bad entries are skipped with a log line rather than thrown, so one fat-
 * fingered secret cannot take down a channel that another key could still
 * serve. If nothing survives, `current` is null and the caller must fail
 * closed — writing plaintext into a column whose entire purpose is that it
 * holds none would be the worst possible fallback.
 */
export async function parseKeys(raw: string): Promise<Keyring> {
  const map = new Map<string, CryptoKey>();
  let current: string | null = null;

  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf(":");
    if (at < 1) { console.error("[chat] MESSAGE_KEYS entry is not id:key"); continue; }

    const id = entry.slice(0, at);
    if (id.includes(".")) { console.error("[chat] key id may not contain a dot —", id); continue; }

    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(entry.slice(at + 1)), (c) => c.charCodeAt(0)); }
    catch { console.error("[chat] key is not base64 —", id); continue; }

    if (bytes.length !== 32) {
      console.error("[chat] key is not 32 bytes —", id, bytes.length); continue;
    }

    map.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
    current ??= id;
  }

  if (!map.size) console.error("[chat] MESSAGE_KEYS is missing or unusable — the channel is closed");
  return { map, current };
}

export async function seal(keys: Keyring, plaintext: string): Promise<string> {
  if (!keys.current) throw new Error("no encryption key");
  // A fresh iv every time. Reusing one under the same key would let an
  // observer see which patients typed the same words.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keys.map.get(keys.current)!,
    new TextEncoder().encode(plaintext),
  );
  return `${PREFIX}.${keys.current}.${b64u.encode(iv)}.${b64u.encode(new Uint8Array(ct))}`;
}

/**
 * Never throws. A body that cannot be opened — retired key, tampered
 * ciphertext, a row the retention job blanked — must not take the rest of the
 * thread with it. The other messages are still the patient's record, and a
 * pharmacist reading a conversation needs to see what survived plus an honest
 * marker where something didn't.
 */
export async function open(keys: Keyring, stored: string): Promise<string> {
  if (stored === PURGED) return NOTE_PURGED;

  // Anything without the prefix predates encryption. Passed through rather
  // than treated as corrupt: it is real text somebody wrote.
  if (!stored.startsWith(PREFIX + ".")) return stored;

  const parts = stored.split(".");
  if (parts.length !== 4) return NOTE_TAMPERED;
  const [, id, iv, ct] = parts;

  const key = keys.map.get(id);
  if (!key) { console.error("[chat] no key for id", id); return NOTE_NO_KEY; }

  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64u.decode(iv) }, key, b64u.decode(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    console.error("[chat] decrypt failed under key", id);
    return NOTE_TAMPERED;
  }
}

/** Opens a whole thread in parallel. Order is preserved. */
export function openAll<T extends { body: string }>(keys: Keyring, rows: T[]): Promise<T[]> {
  return Promise.all(rows.map(async (m) => ({ ...m, body: await open(keys, m.body) })));
}
