# Voice transfer flow

Level 2: the AI completes a prescription transfer entirely by phone.

Viable because **a transfer collects no health information** — name, date of
birth, phone, and the current pharmacy are identity fields, not PHI. That is what
makes this flow safe to build first and why clinical intake by voice is deferred.

## Guardrails

**No PHI, ever.** If the caller starts describing symptoms or naming medications,
the assistant does not record it, does not repeat it, and redirects:
*"I'll have the pharmacist go over your medications with you directly."*

**No health card numbers.** Not needed for a transfer. If offered, decline:
*"I don't need that — we'll sort it out at pickup."*

**Recording notice up front.** Canadian privacy law requires notice before
recording. Say it in the greeting, not buried at the end.

**Transcripts are retained only until the request is actioned**, then purged.
Same retention posture as SMS message bodies.

**Two failed confirmations on any field -> transfer to staff.** Never guess on
identity.

**Emergency detection.** Chest pain, trouble breathing, severe bleeding, or
self-harm -> interrupt immediately: *"That needs urgent attention — please hang up
and call 911."* No further data collection.

## Call script

### 1. Greeting and consent

> Thanks for calling Medixly. I can help you move your prescriptions
> over from another pharmacy — it takes about a minute and you won't need to call
> them yourself. This call is recorded to process your request. Would you like to
> get started?

Wait for yes. Anything other than a clear yes -> offer to transfer to staff.

If the caller wants something else (refill, a question, a product), route:
*"I'll put you through to the team."*

### 2. Name

> First, what's your full name — as it appears on your prescriptions?

Capture. Spell-back for anything not phonetically obvious:
*"Let me make sure I have that — S, H, A, N, E. Is that right?"*

### 3. Date of birth

> And your date of birth?

Accept spoken or keypad entry. Offer keypad if speech fails once:
*"You can also type it on your keypad — month, day, year, four digits for the
year."*

Read back in full: *"March fourteenth, nineteen fifty-two — correct?"*

### 4. Phone

Use caller ID as the default rather than asking cold:

> Is this the best number to reach you on — the one you're calling from?

If no: *"What number should we use?"* Then read back in pairs:
*"Nine oh five, five five five, oh one four two."*

### 5. Current pharmacy

> Which pharmacy are your prescriptions at now? The store name and the nearest
> intersection is plenty.

Read back: *"Shoppers Drug Mart at Yonge and Elgin — is that the one?"*

### 6. Scope

> Would you like everything moved over, or just some of your prescriptions?

Three outcomes: everything / some / not sure. For "some" or "not sure", do **not**
ask which medications — that is PHI. Instead:
*"No problem — the pharmacist will go through them with you when they call."*

### 7. Full read-back

Read all four fields back in one block. This is the step that prevents bad
transfers, so it never gets skipped:

> Let me read that back. Shane Youssef, born March fourteenth nineteen fifty-two,
> reachable at nine oh five five five five oh one four two, transferring
> everything from Shoppers Drug Mart at Yonge and Elgin. Is that all correct?

If no: *"Which part should I fix?"* Re-collect only that field, then read back
again. Two failed cycles -> staff.

### 8. Close

> You're all set. A pharmacist will contact Shoppers today and we'll text you when
> everything's ready. Your reference is T-R-four-seven-two. You don't need to do
> anything else.

Then send the confirmation SMS with the same reference — so the caller has it in
writing and the request exists on both channels.

## After the call

Produces exactly the payload the web form produces:

```json
{
  "intent": "TRANSFER",
  "channel": "voice",
  "pharmacy_id": "...",
  "patient": { "name": "...", "phone": "...", "dob": "..." },
  "from_pharmacy": "...",
  "scope": "all | some | unsure",
  "consent": { "given": true, "at": "...", "method": "verbal, recorded" }
}
```

Same table, same notification, same queue. Voice is another adapter.

## Build notes

- **ConversationRelay** handles speech-to-text, text-to-speech, and barge-in;
  the reasoning stays in our own code. Same principle as SMS: their transport,
  our cognition.
- **Barge-in on.** Older callers interrupt read-backs constantly, and blocking
  that makes the call feel broken.
- **Speech rate slightly slow, one question at a time.** Never stack two
  questions in one prompt.
- **Silence handling.** One re-prompt, then offer staff. Do not loop.
- **Always offer the exit.** "You can say 'talk to someone' at any time."

## Open question before building

Where Twilio processes the voice media, and whether Canadian media routing is
available on our plan. Even without PHI in the transcript, the recording and its
storage region need to be documented in the subprocessor disclosure. Confirm in
the console before committing to this flow.
