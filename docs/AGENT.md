# Agent

`classify.ts` says what a message *is*. The agent says what to *do* about it.

The chat client used to answer a message by matching the word "transfer" in the
browser. It now posts each message to an endpoint that runs the real classifier
and returns a decision — a reply, and where relevant the form card to open. Same
code answers SMS, which is the point: the cognition is one module, and the
channels are adapters.

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
| `PHARMACIST_CHAT` | template | — | **yes** |
| `OTC_ORDER` | template + store link | — | only if no store is configured |
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

**No vaccine intent.** The chat client has a `vaccine` form card and the
classifier has no intent that reaches it, so it is only reachable from the
service rail. Whether vaccine booking is a seventh intent is a decision for the
pharmacy, not one to guess at here.

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
