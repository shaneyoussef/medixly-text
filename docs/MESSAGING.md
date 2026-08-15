# Secure messaging

Two-way conversation between a patient and a pharmacist. The queue dashboard
is one end, the patient chat client is the other, and
`supabase/functions/chat` is in the middle.

This is the only channel in the system that may carry health information.
SMS carries intent and links and nothing else; the forms carry structured,
whitelisted fields; this carries whatever a patient chooses to type, which in
practice is symptoms.

## What "encrypted" means here

| Layer | What protects it |
|---|---|
| In transit | TLS, terminated by Supabase |
| At rest | AES-256-GCM over each message body, keyed by a function secret the database does not hold |
| Access | Patient: a scoped, expiring token. Staff: a shared key (see the gap below) |
| Accountability | Every read, send, open and revoke writes an `audit_log` row — never the message text |

A stolen database dump, a leaked backup, or anyone with table access reads
ciphertext and nothing else.

### It is not end-to-end encryption

Say "encrypted", never "end to end". The pharmacy can read these messages and
**has to be able to**: PHIPA makes Medixly the health information custodian,
which means retaining the record, producing it on an access request, and
letting whichever pharmacist is on duty answer. A scheme the server cannot
read would trade all of that away for a property a custodian is not permitted
to have — and one lost phone would be one destroyed medical record.

The patient notice used to claim end-to-end. It now says "encrypted and
stored in Canada", which is true.

## The envelope

    mx1.<key id>.<base64url iv>.<base64url ciphertext+tag>

Self-describing, so the key id travels with the message. That is what makes
rotation cheap: put a new key at the front of `MESSAGE_KEYS`, leave the old
one behind it, and yesterday's messages still open because they name the key
that sealed them. Nothing rewrites history, so an old key can only be retired
once the messages under it have been purged.

A body with no `mx1.` prefix predates encryption and is passed through. A body
that fails its integrity check is reported as unreadable rather than returned
as plausible text — this channel carries dosing instructions.

## Configuration

Both secrets are required. Without either, the function answers 503 and logs
why; it will not fall back to storing plaintext.

```
STAFF_KEY     openssl rand -base64 24
MESSAGE_KEYS  k1:$(openssl rand -base64 32)
CHAT_URL      https://medixly.netlify.app/     (where the patient link points)
```

## Flow

1. A request arrives in the queue.
2. Staff open the row and press **Open a secure chat**. That mints a token,
   scoped to that one request and good for 14 days, and returns a link.
3. The patient opens the link. No account, no password — the token is the
   credential, which is why it expires and why the client never stores it
   anywhere but the address bar.
4. Both sides poll. Fifteen seconds on the dashboard, eight in the patient
   client. Realtime is the obvious upgrade; polling survives a closed laptop
   lid and is invisible at a pharmacy's volume.
5. **Revoke** kills access immediately, for when a link reaches the wrong
   person.

A patient replying to a closed request reopens it, because otherwise their
message lands where nobody is looking.

## Retention

`purge_old_messages()` blanks bodies once the request has been completed or
cancelled for the retention interval. The row survives with its timestamps:
deleting those would defeat the audit trail they belong to.

## Auditing it

Three layers, because no one of them is enough on its own.

**The algorithm** — `npm run test:crypto`. 49 checks against the same module
the function imports, so it cannot pass while the deployment drifts. Covers
round trips, ciphertext that does not contain its plaintext, a fresh iv every
time, tampering refused rather than returned, rotation, and every flavour of
bad configuration failing closed.

**The deployment** — `STAFF_KEY=... REFERENCE=TR-XXXXX npm run audit:chat`.
Black box over HTTPS with only the things a stolen laptop would have. Probes
the auth boundaries, runs a real message each way, checks a token cannot be
widened to another request, and confirms revoking is immediate. Safe against
production: it sends two marked test messages and revokes at the end.

**The parts a script cannot reach** —

| Check | How |
|---|---|
| Bodies really are ciphertext | `select left(body,12) from messages order by created_at desc limit 5` — every row must start `mx1.` |
| The audit log holds no message text | `select detail from audit_log where action like '%message%'` |
| Database posture | Supabase advisors, after every schema change. They caught a mutable `search_path` on `purge_old_messages` the day it was written |
| Who holds the staff key | A person has to answer this, and the answer changes when someone leaves |

Re-run the advisors after any migration. Re-run the audit script after any
change to the function, and after rotating either secret.

## Gaps

1. **Per-person staff auth.** `x-staff-key` is one shared secret, so the audit
   log records "staff" where PHIPA s.10(1) asks *which* staff. Blocks the
   pilot. Risk 1 in `docs/PIA.md`.
2. **No rate limit** on either side. The patient route is unauthenticated by
   design, so a leaked token can be hammered; the staff route can be
   brute-forced.
3. **The staff key lives in a browser tab**, typed into the queue page.
   Anyone with the device has it.
4. **Rotation is supported but unscheduled.**
