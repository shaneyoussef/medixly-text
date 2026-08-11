# Agent

> **Live in the client again, and not deployed.** `secure-chat.agent.js` is
> loaded, and `POST /api/chat` still is not — the demo runs it against a keyword
> stub. The agent routes; a pharmacist answers everything it hands over.
>
> It came off the shelf to do one job the service rail can't: turn free text into
> the right destination, including a product search when someone is shopping and a
> pharmacist when they are not. See the refusal boundary in docs/SHOP.md.
>
> **The security section at the bottom is now due, not hypothetical.** Region,
> redaction, session auth and rate limiting all gate deployment. One item is
> done: message text no longer reaches the logs.

`classify.ts` says what a message *is*. The agent says what to *do* about it.

The design: a message posts to an endpoint that runs the real classifier and
returns a decision — a reply, and where relevant the form card to open. One
module of cognition, and the channels are adapters onto it.

## It is a router, not a chatbot

This is the constraint everything else follows from, and it is the same one that
made PHIPA tractable in the first place:

- It never asks for medication names, symptoms, diagnoses or health card numbers.
- It never answers a clinical question. A question needing a pharmacist's
  judgment gets a pharmacist, not an answer.
- It never quotes the patient's message back at them.
- It collects nothing. PHI is collected on a form, with its own consent record.

An agent that chatted its way to an answer would put health information in the
transcript and clinical judgment in a model. Both are things this architecture
exists to avoid. If a future change makes the agent conversational, it is not an
improvement to this file — it is a different product with a different privacy
impact assessment.

## Files

| File | What's in it |
| --- | --- |
| `api/agent.ts` | The decision layer. Emergency tripwire, reply templates, intent → form map, two-strikes rule. No I/O of its own. |
| `api/chat.ts` | `POST /api/chat`. Runs the agent, writes the audit row, returns the decision. Holds the API key. |
| `web/form/secure-chat.agent.js` | `MedixlyAgent`: posts each outgoing message, applies the decision to the thread. |
| `test/agent.ts` | The rules below, asserted. No API key needed. |

Reply copy lives in `api/agent.ts` and nowhere else. The browser is a courier for
a decision, not a second opinion on it — the moment reply text exists in two
places, SMS and web chat start drifting apart.

## Order of operations

1. **Emergency tripwire.** Deterministic, and it runs *before* the classifier.
2. **Empty or over-length message.** No classification; goes to a person.
3. **Classify.** A failure here degrades to a human handoff, never a dropped
   message.
4. **Route** on the intent.

## Decisions

| Intent | Reply | Form card | Escalates |
| --- | --- | --- | --- |
| `TRANSFER` | template | `transfer` | no |
| `REFILL` | template | `refill` | no |
| `RX_UPLOAD` | template | `upload` | no |
| `MINOR_AILMENT` | template | `ailment` | no |
| `PHARMACIST_CHAT` | template | `callback` | **yes** |
| `OTC_ORDER`, no health details | template | — (product cards instead) | no |
| `OTC_ORDER`, health details | redirect to a pharmacist | `callback` | **yes** |
| `UNCLEAR`, first turn | the classifier's clarifying question | — | no |
| `UNCLEAR`, second in a row | handoff | — | **yes** |
| emergency tripwire | 911 | — | **yes** |
| classifier unreachable | handoff | — | **yes** |

On SMS there is no form card. The same mapping becomes `linkTo`, which the link
service turns into a tokenized URL.

`MINOR_AILMENT` does not escalate: an Ontario pharmacist assessing and
prescribing for one of the sixteen conditions *is* the self-serve path. The
submission carries the urgent flag (`api/submit.ts`), not the chat turn.

## Why there is a keyword tripwire

The one reply that must never depend on an LLM call succeeding is "call 911". If
the Anthropic API is down, slow, or rate-limited, chest pain still gets an answer
in the same tick.

It also can't use the classifier's own emergency convention. `classify.ts`
returns `PHARMACIST_CHAT` at confidence 1.0 for an emergency — but an ordinary
confident message returns 1.0 too, so the signal isn't distinguishable at the
receiving end.

The four categories in `EMERGENCY_PATTERNS` are taken verbatim from the emergency
rule already in the classifier's system prompt. **No new clinical content was
invented, and the list is not a triage protocol.** A keyword list cannot be
complete. Two things carry that weight instead:

- The standing notice in the chat UI — "Don't send emergency requests here —
  call us or dial 911" — which is on screen before anything is sent and survives
  the network being gone entirely.
- The pharmacy's sign-off on this list before the pilot. **Open item.**

The emergency reply deliberately offers no second number to try. The instruction
is 911; another option is a reason to hesitate.

## Conversation state

The two-strikes rule needs to know whether the previous turn was `UNCLEAR`, and
that is all the history the agent has. State is a list of **intent labels only** —
never message text — so it carries no health information and doesn't become a
retention problem wherever it's stored.

Today it's stored in the browser and arrives in the request body, which means a
caller can send an empty history and get the clarifying question a second time
instead of the handoff. The cost is one extra question, but the rule isn't
*enforceable* until the history lives in a session row server-side. See the
footer of `api/chat.ts`.

## Audit

Every classification writes one `audit_log` row — `action: 'classified'` — with
the intent, confidence, PHI flag, and whether it escalated. It carries **no
message text, no clarifying question and no reply body**: enough to account for
what the system decided, nothing about what the patient said.
`docs/ARCHITECTURE.md` requires every classification to be accounted for; this is
that.

The response to the browser omits `confidence` and `contains_health_details`.
They drive retention and staff routing, and a confidence score in a public
response is a tuning signal handed to anyone who wants to probe the classifier.

## Tests

```
npm run test:agent        # no API key, no network
npm run test:classifier   # needs ANTHROPIC_API_KEY, calls the model
```

The two measure different things. `test:classifier` is a tuning instrument —
accuracy is a judgment call, and a safe miss is often the right answer.
`test:agent` is not: every check in it is a rule the system is supposed to hold,
so a failure there is a bug. It covers the emergency short-circuit, the intent →
form map, SMS versus web copy, the two-strikes rule, safe degradation, and the
invariant that two different messages landing on the same intent produce
byte-identical replies — which is what guarantees a reply can never echo a
health detail.

## Known gaps

**No vaccine intent, and no vaccine form either.** `request_intent` in
`db/schema.sql` has six values and vaccine booking isn't one, so neither the
classifier nor `api/submit.ts` can route one. Whether vaccines are a seventh
intent is a decision for the pharmacy; it needs a migration, not a guess here.

~~**`callback` has no place in the intent → form map.**~~ Done —
`PHARMACIST_CHAT` opens the callback form, and so does a shopping message with a
symptom in it.

**`shopQuery` is the patient's whole message.** `api/shop.ts` strips filler words
before matching, which is what makes "do you have any claritin please" find
Claritin. It is not extraction and there is no model in that path — deliberately,
because a model that rewrites a shopping query is a model that can invent a
product name. The cost is that an unusual phrasing may find nothing; the reply
says so and offers a pharmacist.

**Escalation has nowhere to land.** `escalate: true` reaches the browser and
stops. The staff queue reads `requests`, and a chat turn isn't one.
`docs/ARCHITECTURE.md` describes a `conversations` table that `db/schema.sql`
doesn't have. Until that exists, an escalated chat turn is only as visible as
whoever happens to be watching the chat — which is not good enough for
`PHARMACIST_CHAT` and is the first thing to close before the pilot.

**No rate limiting.** `POST /api/chat` spends money on every call and nothing
stops anyone from calling it in a loop.

**No message persistence.** The endpoint classifies a message; it doesn't store
the thread. Nothing in the chat survives a reload.

**The web chat sends message text to Anthropic.** Unlike SMS, a web chat message
can legitimately contain health details, and classification happens at
Anthropic. That is contemplated — Anthropic is on the list of service providers
needing a written agreement in `ROADMAP.md` Phase 0 — but the agreement has to be
in place before real patients, and `docs/PIA.md` should name the flow explicitly.

---

## Security — read this before switching it back on

Parking the agent closed a question it had opened, and the answer is written
down here so it doesn't have to be rediscovered.

`docs/COMPLIANCE.md` says the classifier "may **incidentally** see health info."
That is true on **SMS**, where *no PHI over SMS* is a rule the system enforces —
which is what made an Anthropic subprocessor acceptable in the first place. On
**web chat it inverts.** The chat is the secure channel: the page tells patients
their conversation is protected, `docs/privacy-documents.md` §4 tells them to use
it *instead of* text and email, and the assessment form is symptoms by design. A
classifier on that channel sees high-sensitivity PHI routinely, not incidentally.

So turning it on for web chat is not a config change. Three claims break:

| Where | Claim | Reality with a US classifier in the web path |
|---|---|---|
| `docs/PIA.md` §8 | Anthropic — "not yet in production path", exposure "when SMS launches" | In the path, via web chat, before SMS |
| `docs/PIA.md` §10 risk 12 | "Data residency — **Closed** — `ca-central-1`" | Reopened — `api/classify.ts` posts to `api.anthropic.com` |
| `docs/privacy-documents.md` §4 | "stored in **Canada**"; only a first name leaves the country | False — health information would leave it |

What would make it defensible, in the order that matters:

1. **Run classification in Canada.** `classify()` is one `fetch` in one function,
   so this is a one-function change: Claude on Bedrock in `ca-central-1`, or
   Vertex AI in `northamerica-northeast1`. Verify the model is actually offered
   in the region before committing to it. This is what re-closes risk 12.
2. **Minimise what crosses the boundary.** Intent routing never needs a name,
   date of birth, health card number, phone or email — strip them before the
   call. Minimisation, not anonymisation: symptoms remain and the session still
   ties the message to a person.
3. **Require a session and rate limit `POST /api/chat`.** It is unauthenticated
   as written, so anyone can post text and spend credits.
4. ~~**Keep message text out of the logs.**~~ Done. `classify()` throws with the
   status only, and `api/agent.ts` logs a message rather than an error object, so
   a provider's error body can no longer carry patient text into a log store.
5. **Get the subprocessor agreement and zero retention in writing**, and disclose
   the flow in the privacy notice.

One control already exists and is the reason parking the agent costs so little:
`renderServices()` routes a service-rail chip straight to `requestForm()`. **No
text leaves the device and no model is involved.** Every chip in
`secure-chat.forms.js` carries `form:` for exactly that reason. The agent's value
was never the five things a chip already does — it was free text, and a
pharmacist reads that better than a classifier does.

Last thing, and it is independent of region: `web/form/index.html` tells patients
"This conversation is encrypted end to end." An agent has to read the plaintext,
so a third party reads it in the middle, and that claim does not survive in any
region. The trust badge ("transmitted securely via Hushmail for Healthcare") is
defensible; "end to end" is not. `web/HANDOFF.md` says to ask before changing
compliance wording, so it is flagged rather than changed — it belongs with the
privacy officer, alongside the PHIPA-versus-PIPEDA question.
