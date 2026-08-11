/**
 * Intent classifier for inbound patient messages.
 *
 * Text in, JSON out. No database, Twilio, or AWS dependencies — this module is
 * deliberately transport-agnostic so it can be iterated on and tested locally
 * long before any of that exists, and reused unchanged by SMS, web chat, or a
 * future agent-callable API.
 */

export const INTENTS = [
  "REFILL",
  "TRANSFER",
  "RX_UPLOAD",
  "MINOR_AILMENT",
  "PHARMACIST_CHAT",
  "OTC_ORDER",
  "UNCLEAR",
] as const;

export type Intent = (typeof INTENTS)[number];

export interface Classification {
  intent: Intent;
  confidence: number;
  clarifying_question: string | null;
  contains_health_details: boolean;
}

/** Below this, we don't trust the label. */
export const CONFIDENCE_FLOOR = 0.75;

export const SYSTEM_PROMPT = `You classify incoming messages from pharmacy patients in Ontario, Canada.

Return ONLY a JSON object. No prose, no markdown fences, no explanation.

Schema:
{
  "intent": "REFILL" | "TRANSFER" | "RX_UPLOAD" | "MINOR_AILMENT" | "PHARMACIST_CHAT" | "OTC_ORDER" | "UNCLEAR",
  "confidence": number between 0 and 1,
  "clarifying_question": string or null,
  "contains_health_details": boolean
}

Intents:
- REFILL — patient wants more of a medication they already take
- TRANSFER — patient wants to move prescriptions from another pharmacy to this one
- RX_UPLOAD — patient has a new prescription from a prescriber to submit
- MINOR_AILMENT — a condition an Ontario pharmacist can assess and prescribe for:
  acne, allergic rhinitis, oral thrush, conjunctivitis (pink eye), dermatitis,
  menstrual cramps, GERD/heartburn, hemorrhoids, cold sores, impetigo, insect
  bites and hives, muscle sprains and strains, nausea and vomiting in pregnancy,
  tick bites, urinary tract infection, yeast infection
- PHARMACIST_CHAT — a question needing a pharmacist's judgment: drug interactions,
  side effects, dosing, or any clinical concern that isn't clearly a minor ailment
- OTC_ORDER — over-the-counter products, vitamins, supplements, wellness items,
  or anything the patient wants to buy off the shelf
- UNCLEAR — cannot determine the intent with confidence

Rules:
- NEVER ask for medication names, symptoms, diagnoses, or health card numbers.
- Set contains_health_details to true if the message mentions symptoms, conditions,
  diagnoses, or specific medications. Never repeat those details in the
  clarifying_question.
- clarifying_question is one short sentence offering options. Example:
  "Happy to help — is this for a refill, a new prescription, or something else?"
  Set it to null for any intent other than UNCLEAR.
- When torn between MINOR_AILMENT and PHARMACIST_CHAT, choose PHARMACIST_CHAT.
  A human should make clinical routing calls.
- A message that mentions BOTH an existing medication running out AND a new
  symptom is REFILL only if the refill is clearly the ask; otherwise
  PHARMACIST_CHAT.
- Messages in French are classified normally. Reply language is handled downstream.
- Greetings, thanks, and small talk with no request are UNCLEAR.
- If the message describes an emergency (chest pain, trouble breathing, severe
  bleeding, thoughts of self-harm), return PHARMACIST_CHAT with confidence 1.0 —
  downstream handling routes these to a human immediately.`;

const MODEL = "claude-sonnet-4-6";

/**
 * Classify one message. Throws on network failure; returns a safe UNCLEAR
 * fallback if the model returns anything unparseable.
 */
export async function classify(
  message: string,
  apiKey: string = process.env.ANTHROPIC_API_KEY ?? "",
): Promise<Classification> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!res.ok) {
    // Status only. An error body can echo the request back, and this text is a
    // patient's message — the audit design keeps message text out of stored
    // records, so it must not arrive in a log through the back door instead.
    throw new Error(`Anthropic API ${res.status}`);
  }

  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  return validate(text);
}

/**
 * Parse and sanity-check the model output. Anything suspect degrades to
 * UNCLEAR rather than guessing — a wrong confident label on a health request
 * is worse than asking one extra question.
 */
export function validate(raw: string): Classification {
  const fallback: Classification = {
    intent: "UNCLEAR",
    confidence: 0,
    clarifying_question:
      "Happy to help — is this about a prescription, a health concern, or an over-the-counter product?",
    contains_health_details: false,
  };

  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return fallback;
  }

  if (!INTENTS.includes(parsed.intent)) return fallback;

  const confidence =
    typeof parsed.confidence === "number" &&
    parsed.confidence >= 0 &&
    parsed.confidence <= 1
      ? parsed.confidence
      : 0;

  // Low confidence is treated as UNCLEAR regardless of the label returned.
  if (confidence < CONFIDENCE_FLOOR && parsed.intent !== "UNCLEAR") {
    return {
      ...fallback,
      confidence,
      contains_health_details: parsed.contains_health_details === true,
    };
  }

  return {
    intent: parsed.intent,
    confidence,
    clarifying_question:
      typeof parsed.clarifying_question === "string"
        ? parsed.clarifying_question
        : null,
    contains_health_details: parsed.contains_health_details === true,
  };
}
