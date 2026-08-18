# Medixly — test and audit plan

A living document. One section per feature, added when the feature is built,
kept when it ships. Nothing reaches a real patient until its section is signed
off at the bottom of this file.

Written for a pharmacy, not for a software team, so the standard is not "the
tests pass" — it is **"I would be comfortable if this failed in front of the
College of Pharmacists."**

---

## How to use this

1. A feature gets built.
2. Its section is written **here, first** — before it is called done.
3. The section is worked top to bottom. Every line gets a result and a date.
4. Anything marked **BLOCKER** that fails stops the feature. Not "fix later".
5. The sign-off table at the bottom gets a row.
6. When the feature changes, its section is re-run. Not skimmed. Re-run.

Re-run a section in full when any of these happen:

- the feature's code changes
- a secret is rotated
- the database schema changes
- Supabase, Netlify or Twilio change something under us
- three months have passed

---

## The standing rules

These apply to every feature, forever. They are not re-argued per feature.

| # | Rule | Why |
|---|---|---|
| S1 | No patient health information leaves Canada | PHIPA, and the promise in the privacy notice |
| S2 | Every access to a patient record is logged, with a timestamp | PHIPA s.10(1) — the custodian must account for access |
| S3 | The log never contains the health information itself | Otherwise the audit trail is a second copy to protect |
| S4 | Nothing claims a security property it does not have | A false claim in a privacy notice is a misrepresentation |
| S5 | Failure is closed, never open | A broken feature refuses to work; it does not quietly work insecurely |
| S6 | A patient can always reach a human | No feature stands between someone and the phone |
| S7 | Test data is never real patient data | Not a shortcut worth taking, ever |

### Severity

| | Meaning | What happens |
|---|---|---|
| **BLOCKER** | A patient could be harmed, or their information exposed | Feature does not ship. Full stop. |
| **HIGH** | Breaks a promise made to patients or a regulator | Fixed before pilot |
| **MEDIUM** | Wrong, but contained and recoverable | Fixed before general use |
| **LOW** | Rough edge | Logged, scheduled |

### Kill criteria

Stop and fix immediately, whatever else is happening, if any of these is ever
true:

- A message body is readable in the database
- One patient can see another patient's information
- A shared secret is found in source code, a screenshot, an email or a chat
- The audit log can be edited or deleted
- A feature fails *open* — keeps working after its security check breaks

---

# Feature 1 — Encrypted patient ↔ pharmacist messaging

**What it is:** a patient follows a link from the pharmacy and exchanges
messages with a pharmacist. Bodies are AES-256-GCM at rest under a key the
database does not hold; TLS in transit.

**What it is not:** end-to-end encrypted. The pharmacy can read these and must
be able to — see `docs/MESSAGING.md`.

**Status:** built, deployed, **not yet verified end to end.**

---

## L0 — Before touching anything

| # | Check | Sev | Result |
|---|---|---|---|
| 0.1 | `STAFF_KEY` and `MESSAGE_KEYS` are set in Supabase, and nowhere else | BLOCKER | |
| 0.2 | `MESSAGE_KEYS` is written down in the password manager, and someone other than the owner can reach it | BLOCKER | |
| 0.3 | No secret appears anywhere in the repository — `git log -p \| grep -i "key\|secret"` | BLOCKER | |
| 0.4 | Supabase project region is `ca-central-1` | BLOCKER | |
| 0.5 | The queue site is not publicly reachable without a password | BLOCKER | |

> 0.3 matters here specifically: the staff key **was** hardcoded in the chat
> function's source. It has been removed, but the old value is in git history.
> The current key must not be that one.

## L1 — The algorithm

`npm run test:crypto` — 49 checks. Runs against the same module the deployed
function imports.

| # | Check | Sev | Result |
|---|---|---|---|
| 1.1 | All 49 pass | BLOCKER | |
| 1.2 | Ciphertext never contains its plaintext | BLOCKER | |
| 1.3 | The same sentence sealed twice produces different rows | HIGH | |
| 1.4 | A flipped bit is refused, not returned as plausible text | BLOCKER | |
| 1.5 | Bad configuration leaves no encrypting key at all | BLOCKER | |
| 1.6 | A message sealed under an old key still opens after rotation | HIGH | |

## L2 — The deployment

`STAFF_KEY=... REFERENCE=TR-XXXXX npm run audit:chat`

Black box over HTTPS, knowing only what a stolen laptop would know.

| # | Check | Sev | Result |
|---|---|---|---|
| 2.1 | All checks pass | BLOCKER | |
| 2.2 | Wrong key, and wrong key of the *right length*, both refused | BLOCKER | |
| 2.3 | A patient token cannot be widened to another request | BLOCKER | |
| 2.4 | Revoking is immediate for reading and sending | HIGH | |
| 2.5 | Staff keep the history after revoking | HIGH | |
| 2.6 | Nothing comes back `[unreadable]` | BLOCKER | |

## L3 — Adversarial

Try to break it on purpose. None of this is automated; it is an hour with the
system and bad intentions.

| # | Attack | Expected | Sev | Result |
|---|---|---|---|---|
| 3.1 | Guess a token — try 1,000 random ones | All 404 | HIGH | |
| 3.2 | Measure whether a wrong key fails faster the more of it is right | No measurable difference | MEDIUM | |
| 3.3 | SQL in the reference: `?reference=TR-1' or '1'='1` | Refused, nothing leaked | BLOCKER | |
| 3.4 | SQL in the token | Refused | BLOCKER | |
| 3.5 | Null bytes, RTL overrides and 4-byte emoji in a message body | Stored and returned intact, no crash | MEDIUM | |
| 3.6 | `PUT`, `DELETE`, `PATCH` on both routes | 405 | MEDIUM | |
| 3.7 | Send 200 messages in 10 seconds on one token | After ~40 in a minute, 429. Limit is per isolate. | HIGH | |
| 3.8 | Brute-force the staff key from a script | After 8 failures from one IP in 10 minutes, 429. Limit is per isolate. | HIGH | |
| 3.9 | Call the function from a random website's console with a stolen token | CORS does not echo that origin and does not send `*` | MEDIUM | |
| 3.10 | Open a link, then have staff revoke it, then press Back | No cached thread returns | HIGH | |
| 3.11 | Expire a token by hand (`update requests set chat_expires_at = now() - interval '1 day'`) and use it | 410, clear message | HIGH | |
| 3.12 | Point a patient token at the staff route and vice versa | Neither crosses over | BLOCKER | |

> 3.7 and 3.8 are limited per Deno isolate, not globally. Treat a pass as
> "this isolate slowed down", not "guessing is impossible".

## L4 — What is actually on disk

The only proof that encryption is on. Run in the Supabase SQL editor.

```sql
-- Every row must start "mx1." . If you can read a sentence, stop.
select left(body, 12) as starts_with, length(body), sender, created_at
  from messages order by created_at desc limit 10;

-- The audit trail must know that a message happened, not what it said.
select action, detail from audit_log
 where action like '%message%' order by at desc limit 20;

-- Row-level security is on.
select relname, relrowsecurity from pg_class
 where relname in ('messages','requests','audit_log');
```

| # | Check | Sev | Result |
|---|---|---|---|
| 4.1 | Every body starts `mx1.` | BLOCKER | |
| 4.2 | No message text anywhere in `audit_log.detail` | BLOCKER | |
| 4.3 | RLS enabled on `messages`, `requests`, `audit_log` | HIGH | |
| 4.4 | Supabase security advisors return zero findings | HIGH | |
| 4.5 | `audit_log` cannot be updated or deleted by the app role | HIGH | |

## L5 — The client, in a real browser

Open the patient link on a phone, with developer tools attached.

| # | Check | Sev | Result |
|---|---|---|---|
| 5.1 | The token is **not** in localStorage, sessionStorage or a cookie | HIGH | |
| 5.2 | No third-party script loads on the chat page — no analytics, no pixel, no font CDN carrying a referrer | BLOCKER | |
| 5.3 | The dashboard holds no decrypted message text after a row is collapsed | HIGH | |
| 5.4 | Message text never appears in a URL | HIGH | |
| 5.5 | The page is HTTPS only, with no mixed content | HIGH | |
| 5.6 | Airplane mode mid-send: the message fails visibly and can be retried, never silently vanishes | MEDIUM | |
| 5.7 | Leaving the tab for an hour and returning does not expose the thread without a fresh check | MEDIUM | |

## L6 — Recovery drills

Do these once, deliberately, on test data. They are the questions asked after
something has already gone wrong.

| # | Drill | Pass condition | Sev | Result |
|---|---|---|---|---|
| 6.1 | Rotate `MESSAGE_KEYS`: put `k2:` in front, keep `k1:` behind | Old messages still open, new ones seal under `k2` | HIGH | |
| 6.2 | Remove `k1:` while messages sealed under it still exist | They show `[unreadable]` — **never plaintext** | BLOCKER | |
| 6.3 | Rotate `STAFF_KEY` | Dashboard locks out until the new key is entered; patient links unaffected | HIGH | |
| 6.4 | Restore the database from a backup | Restored messages still decrypt | HIGH | |
| 6.5 | Delete `MESSAGE_KEYS` entirely | Function 503s. It does **not** serve, and does not write plaintext | BLOCKER | |
| 6.6 | Run `purge_old_messages()` on completed test data | Bodies blanked, rows and timestamps intact | HIGH | |

## L7 — Compliance rehearsal

Answer these out loud, with a stopwatch. If you cannot, the feature is not
ready regardless of what the tests say.

| # | Question | Sev | Result |
|---|---|---|---|
| 7.1 | A patient asks for everything you hold about them. Can you produce the full transcript, and how long does it take? | HIGH | |
| 7.2 | A patient asks you to correct something. What do you do? | MEDIUM | |
| 7.3 | *Which named person* read this patient's messages on this date? | **BLOCKER — cannot be answered today.** Shared staff key | |
| 7.4 | The staff key leaks. What happens, who does it, how fast? | HIGH | |
| 7.5 | How long are messages kept, and who decided? | HIGH | |
| 7.6 | Show the patient-facing description of this feature. Is every word of it true? | BLOCKER | |
| 7.7 | Someone leaves the pharmacy. What must change by end of day? | HIGH | |

## L8 — Known gaps

Carried openly rather than quietly. Each one is a test above that is red.

| Gap | Test | Severity | Owner | Target |
|---|---|---|---|---|
| Shared staff key — the audit log cannot say *who* | 7.3 | BLOCKER | | Before pilot |
| Rate limits are per isolate, not global | 3.7, 3.8 | HIGH | | Before pilot |
| Staff key lives in a browser tab | L0 | MEDIUM | | Before pilot |
| Key rotation is possible but unscheduled | 6.1 | LOW | | First rotation within 12 months |
| Edge function decrypts near the caller, not pinned to Canada | 0.4 | HIGH | | Before pilot |

---

# Template — copy this for each new feature

```
# Feature N — <name>

**What it is:**
**What it is not:**
**Status:**

## L0 — Before touching anything
Secrets, configuration, access. What must be true before testing means anything.

## L1 — The logic
Automated. The rules the feature enforces, tested against the real module.

## L2 — The deployment
Black box against what is actually running, knowing only what an outsider knows.

## L3 — Adversarial
An hour spent trying to break it. Write the attacks down even when they succeed.

## L4 — What is on disk
The SQL that proves the claim. If a claim cannot be proved by a query, it is
not a claim, it is a hope.

## L5 — The client, in a real browser
What leaks into storage, into URLs, into third-party scripts, into a cached page.

## L6 — Recovery drills
Rotate it, break it, restore it. Once, deliberately, on test data.

## L7 — Compliance rehearsal
The questions a patient or a regulator asks. Answer them out loud.

## L8 — Known gaps
Every red test above, carried openly with an owner and a date.
```

**Three questions for any new feature, before writing its plan:**

1. What is the worst thing this feature could do to a patient?
2. What does it claim, and can each claim be proved by a query or a test?
3. What happens when it fails — does it stop, or does it keep going insecurely?

---

# Sign-off

A feature is not done when it works. It is done when this row is filled in.

| Feature | L0–L8 complete | Blockers closed | Tested by | Date | Approved for |
|---|---|---|---|---|---|
| 1 — Encrypted messaging | | | | | *not yet — staff test data only* |

**Approved for** is one of: *nobody yet* · *staff test data only* · *pilot,
consenting patients* · *general use*. It never skips a step.
