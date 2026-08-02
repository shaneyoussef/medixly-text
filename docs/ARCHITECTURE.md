# Architecture

## Request flow

```
Patient message (SMS or web chat)
    |
    v
Transport adapter
    |  SMS: Twilio toll-free -> webhook, signature-verified
    |  Web: chat widget -> same endpoint
    v
API  [ca-central-1]
    |
    v
Classifier -> { intent, confidence, contains_health_details }
    |
    v
Link service -> tokenized short URL (72h expiry)
    |
    v
Reply to patient
    |
    v
Patient opens Medixly form (HTTPS) -> submits PHI + consent
    |
    v
Encrypted storage (RDS + S3, ca-central-1)
    |
    v
Pharmacist notified (Hushmail / dashboard / whatever they actually check)
```

## Transport is an adapter, not the architecture

The layer beneath the classifier — create a request record, notify a pharmacist —
never knows whether the trigger was SMS, web chat, or an agent API call. This is
what makes the channel swappable, and what makes an agent-callable endpoint a
week of work later instead of a rewrite.

The six intents are already a tool schema. The form fields are already input
schemas. When patients' own AI assistants start making these requests, that
mapping is the product.

## Modules

```
medixly-text/
|- api/
|  |- webhook.ts        # Twilio inbound, signature check, rate limit
|  |- classify.ts       # intent classification
|  |- reply.ts          # copy templates per intent
|  \- links.ts          # tokenized short-link generation
|- web/
|  \- chat.html         # web chat adapter (also a real site widget)
|- forms/
|  |- transfer          # build first — the acquisition intent
|  |- refill / upload
|  \- minor-ailment / otc / chat
|- workers/
|  |- notify.ts         # pharmacist notifications
|  \- retention.ts      # scheduled purge per retention policy
\- db/
   \- schema.sql
```

## Data model

### conversations
Phone number (hashed), `pharmacy_id`, consent status and timestamp, opt-out flag.
Message bodies are **not** retained past the audit window — patients volunteer
health details by text and we don't want to be storing them.

### requests
`intent`, link token, status (`sent -> opened -> submitted -> completed`),
`pharmacy_id`, timestamps. Doubles as funnel analytics: which intents convert,
where patients drop off.

### submissions
Form payloads. Encrypted at rest via KMS. Field-level encryption on health card
numbers. Access scoped to the owning pharmacy.

### audit_log
Append-only. Every access, send, and classification. PHIPA requires the custodian
to account for who touched what and when.

## Key design decisions

**Links instead of a conversational bot.** A bot collecting health details over
SMS would put PHI in Twilio's US infrastructure and in the patient's unencrypted
message history. Links keep regulated data on infrastructure we control.

**Tokenized links.** No patient identifier in the URL. 72-hour expiry. A forwarded
or screenshotted link leaks nothing and doesn't stay live.

**MMS disabled.** Prevents prescription photos from landing in US storage. The
RX_UPLOAD reply says explicitly: don't text photos, use the secure link.

**Classifier fallback.** Two failed classifications routes to a human queue.
Never guess on health requests.

**Own the classifier.** Twilio's AI Assistants product would handle this, but it
retains conversation history and builds customer profiles on US infrastructure,
and adds an LLM subprocessor we didn't choose. Twilio for transport, our code for
cognition.
