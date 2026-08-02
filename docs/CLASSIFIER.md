# Classifier

## Output contract

The model returns JSON only — no prose, no markdown fences:

```json
{
  "intent": "REFILL | TRANSFER | RX_UPLOAD | MINOR_AILMENT | PHARMACIST_CHAT | OTC_ORDER | UNCLEAR",
  "confidence": 0.0,
  "clarifying_question": null,
  "contains_health_details": false
}
```

- `confidence < 0.75` -> treat as `UNCLEAR` and ask the clarifying question.
- Two `UNCLEAR` turns in a row -> hand off to the human queue.
- `contains_health_details: true` -> flag the message for shortened retention and
  make sure the reply doesn't echo any of it back.

See `api/classify.ts` for the live system prompt and the validation logic.

## What "good" means here

Raw accuracy is the wrong target. The test harness splits misses into two kinds:

- **Safe miss** — landed on `PHARMACIST_CHAT` or `UNCLEAR`. A human sees it.
  Acceptable, and often correct behaviour on an ambiguous message.
- **Unsafe miss** — a clinical concern routed to a self-serve form. These are the
  only ones that block launch.

Chasing a high accuracy number pushes the prompt toward confident guessing, which
is the opposite of what a health intake system should do.

## Separate check: PHI detection

Every message tagged `health-details` in the test set should come back with
`contains_health_details: true`. That flag drives shortened retention, so a
classifier that gets intents right but misses PHI detection is a compliance
problem rather than an accuracy problem. The harness reports it separately.

## Reply templates

Each intent maps to a short message with a tokenized link. Keep replies under two
SMS segments (~300 chars) to control cost.

First-time senders get the consent and not-secure disclosure before anything else.
No reply ever contains health details.

`RX_UPLOAD` replies must say explicitly not to text photos — MMS is disabled, so
the patient needs to know why their picture didn't send.
