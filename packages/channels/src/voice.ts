/**
 * Voice.
 *
 * The channel where the constraints are legal rather than technical, and where
 * getting them wrong is not a bug report but a letter from a regulator.
 *
 * **Disclosure is mandatory and must not be the model's job.** Several
 * jurisdictions require a bot to identify itself as one when calling a person —
 * California's BOT Act among them, and the list grows. A model told to "mention
 * you're an AI assistant" will comply almost always, and almost always is the
 * wrong standard for a legal obligation. So the disclosure is a fixed utterance
 * played before the model is connected to the audio at all. The agent cannot
 * forget it, cannot be talked out of it, and cannot decide this particular call
 * does not need it.
 *
 * **Recording needs consent, and consent has a geography.** Roughly a dozen US
 * states and most of Europe require every party to agree before a call is
 * recorded. So recording starts refused, is requested explicitly, and a refusal
 * is honoured for the whole call — including for the transcript, because a
 * transcript of a call someone declined to have recorded is a recording with
 * extra steps.
 *
 * **Everything the other party says is untrusted.** A call is a channel where an
 * agent can be socially engineered in real time, by someone who adapts. "I'll
 * need the card number to verify the account" is what a legitimate agent says
 * and what an attacker says, and no amount of listening tells them apart. The
 * transcript is third-party content, and what a call is *allowed to commit to*
 * is bounded before it is dialled rather than judged during it.
 */

import type { Provenance } from "@nell/shared";
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Which model runs the call                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the audio is turned into conversation.
 *
 * There is a real tension here with the promise that a deployment picks its own
 * models, and it is worth stating rather than papering over:
 *
 * - **`realtime`** is speech-to-speech: audio in, audio out, one model, no
 *   transcription step. It is what makes a call feel like a call — roughly half
 *   a second to first sound, and the model hears tone, interruption and
 *   hesitation rather than a flattened transcript. Only a couple of vendors
 *   offer it (OpenAI's Realtime API, Google's Live API), so choosing it means
 *   choosing one of them *for voice specifically*.
 *
 * - **`pipeline`** is speech-to-text, then any text model, then text-to-speech.
 *   Slower — the stages add up, and the model cannot hear someone start to
 *   interrupt — but it runs on whatever the user already chose, including a
 *   model on their own hardware. For a self-hoster who connected a local model
 *   precisely so no audio leaves their machine, this is the only honest option.
 *
 * Both are supported and the deployment picks. Defaulting to realtime and
 * calling the product model-agnostic would be a claim the voice channel quietly
 * breaks; offering only the pipeline would make calls feel worse than they need
 * to for users who do not care.
 */
export const voiceModeSchema = z.enum(["realtime", "pipeline"]);
export type VoiceMode = z.infer<typeof voiceModeSchema>;

export interface VoiceModelChoice {
  readonly mode: VoiceMode;
  /** For `realtime`: the speech-to-speech model. */
  readonly realtimeModel?: string;
  /** For `pipeline`: the three stages, each independently swappable. */
  readonly transcriber?: string;
  readonly reasoner?: string;
  readonly speaker?: string;
}

/**
 * Spoken audio arrives two ways, and they are not the same problem.
 *
 * A **call** is live and duplex. Someone is holding a phone waiting for a reply,
 * so latency is the whole game and a speech-to-speech model earns its price.
 *
 * A **note** — a WhatsApp or iMessage voice message — has already finished
 * arriving. Nobody is waiting on a half-second budget, which means the expensive
 * realtime path buys nothing at all. Treating the two identically is how a
 * product ends up paying call prices to answer a message that sat in a queue for
 * six minutes.
 */
export const voiceMediumSchema = z.enum(["call", "note"]);
export type VoiceMedium = z.infer<typeof voiceMediumSchema>;

export interface RealtimeModel {
  readonly id: string;
  /** Cost per minute of conversation, in minor units. Audio is billed by time. */
  readonly costPerMinute: number;
  readonly vendor: "openai" | "google";
}

/**
 * Models that can hold a spoken conversation directly.
 *
 * Both are listed with a price because there is no reason to prefer one on
 * principle: they are close enough in quality that cost is the sensible
 * tiebreaker, and both are subject to change.
 */
export const REALTIME_MODEL_OPTIONS: readonly RealtimeModel[] = [
  { id: "openai/gpt-realtime", costPerMinute: 24, vendor: "openai" },
  { id: "google/gemini-live", costPerMinute: 18, vendor: "google" },
];

export const REALTIME_MODELS: readonly string[] = REALTIME_MODEL_OPTIONS.map((model) => model.id);

/**
 * Pick the cheaper realtime model a deployment can actually reach.
 *
 * Restricted to what has a key, because the cheapest model nobody can call is
 * not a saving. Returns nothing when neither is available, so the caller falls
 * back to the pipeline rather than placing a call that connects to silence.
 */
export function cheapestRealtime(
  available: readonly string[],
  options: readonly RealtimeModel[] = REALTIME_MODEL_OPTIONS
): RealtimeModel | undefined {
  return [...options]
    .filter((model) => available.includes(model.vendor))
    .sort((a, b) => a.costPerMinute - b.costPerMinute)[0];
}

/**
 * Models that can listen to a recording, without holding a conversation.
 *
 * A far wider set than the realtime one, and much cheaper, because
 * understanding an audio file is an ordinary multimodal capability rather than
 * a live duplex stream. For a voice note this is the whole job.
 */
export const AUDIO_INPUT_MODELS: readonly string[] = [
  "openai/gpt-5.6",
  "google/gemini-3.5-flash",
  "google/gemini-live",
  "openai/gpt-realtime",
];

export type NotePlan =
  | { readonly kind: "native-audio"; readonly model: string; readonly why: string }
  | {
      readonly kind: "transcribe-then-answer";
      readonly transcriber: string;
      readonly reasoner: string;
      readonly why: string;
    };

/**
 * How to answer a voice note.
 *
 * Prefers handing the audio straight to a model that can hear it: one step
 * instead of two, and tone and emphasis survive, which a transcript flattens —
 * "no, the *later* flight" is a different sentence with the stress removed.
 *
 * Falls back to transcribing first when the chosen model cannot listen, which is
 * the case for most text models and for anything self-hosted. Both are cheap;
 * neither needs a realtime model, and reaching for one here is paying call
 * prices to answer a message that has already been waiting.
 */
export function planForNote(
  reasoner: string,
  transcriber: string,
  audioCapable: readonly string[] = AUDIO_INPUT_MODELS
): NotePlan {
  if (audioCapable.includes(reasoner)) {
    return {
      kind: "native-audio",
      model: reasoner,
      why: "It can listen to the recording directly, so tone and emphasis are not lost to a transcript.",
    };
  }

  return {
    kind: "transcribe-then-answer",
    transcriber,
    reasoner,
    why: `${reasoner} cannot listen to audio, so the note is transcribed first.`,
  };
}

export type VoiceConfigProblem =
  | { readonly kind: "not-realtime-capable"; readonly model: string }
  | { readonly kind: "incomplete-pipeline"; readonly missing: readonly string[] };

/**
 * Check a voice configuration before a call is placed.
 *
 * A misconfiguration discovered mid-call is a person listening to silence, so
 * this is checked at setup. The realtime check matters most: pointing the
 * realtime mode at an ordinary chat model produces a call that connects and then
 * says nothing, which reads as a broken phone line rather than a settings error.
 */
export function checkVoiceConfig(choice: VoiceModelChoice): readonly VoiceConfigProblem[] {
  if (choice.mode === "realtime") {
    const model = choice.realtimeModel ?? "";
    return REALTIME_MODELS.includes(model)
      ? []
      : [{ kind: "not-realtime-capable", model: model || "(none chosen)" }];
  }

  const missing = (
    [
      ["transcriber", choice.transcriber],
      ["reasoner", choice.reasoner],
      ["speaker", choice.speaker],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return missing.length > 0 ? [{ kind: "incomplete-pipeline", missing }] : [];
}

export function explainVoiceConfigProblem(problem: VoiceConfigProblem): string {
  switch (problem.kind) {
    case "not-realtime-capable":
      return `${problem.model} cannot hold a spoken conversation directly. Pick a realtime model, or switch to the pipeline mode and use any model you like.`;
    case "incomplete-pipeline":
      return `The voice pipeline is missing its ${problem.missing.join(" and ")}. All three stages are needed before a call can be placed.`;
  }
}

export const callDirectionSchema = z.enum(["inbound", "outbound"]);
export type CallDirection = z.infer<typeof callDirectionSchema>;

/**
 * Places where every party must agree before a call is recorded.
 *
 * Not exhaustive, and deliberately over-inclusive: the cost of asking for
 * consent where it was not required is a sentence, and the cost of not asking
 * where it was is a criminal offence in several of these.
 */
export const ALL_PARTY_CONSENT = new Set([
  "US-CA",
  "US-DE",
  "US-FL",
  "US-IL",
  "US-MD",
  "US-MA",
  "US-MI",
  "US-MT",
  "US-NV",
  "US-NH",
  "US-OR",
  "US-PA",
  "US-WA",
  "GB",
  "IE",
  "DE",
  "FR",
  "ES",
  "IT",
  "NL",
  "SE",
  "NO",
  "DK",
  "FI",
  "PL",
  "PT",
  "AT",
  "BE",
]);

export function needsRecordingConsent(region: string): boolean {
  const normalized = region.toUpperCase();
  // An unknown region is treated as requiring consent. Guessing wrong in the
  // permissive direction is the expensive one.
  if (!/^[A-Z]{2}(-[A-Z]{2})?$/u.test(normalized)) return true;
  if (ALL_PARTY_CONSENT.has(normalized)) return true;
  return !normalized.startsWith("US");
}

/**
 * What the callee hears first.
 *
 * Fixed text, played before the model is connected to the audio. A model asked
 * to disclose will comply almost always, and almost always is the wrong standard
 * for something a regulator measures.
 */
export function disclosure(callerName: string): string {
  return (
    `Hello — this is an AI assistant calling on behalf of ${callerName}. ` +
    `I'm not a person. You can ask to speak to them directly at any time.`
  );
}

export function recordingRequest(): string {
  return "Before we go on — is it alright if I record this call so I can note what we agree?";
}

/** Words that count as agreeing to be recorded. Anything else does not. */
const AGREEMENT = /\b(yes|yeah|yep|sure|ok|okay|fine|go ahead|that's fine|no problem)\b/iu;
const REFUSAL = /\b(no|nope|don't|do not|rather not|prefer not|not comfortable)\b/iu;

/**
 * Interpret an answer about recording.
 *
 * Ambiguity is a refusal. A person who says "I suppose so, but…" has not agreed,
 * and treating a hedge as consent is how a recording ends up in evidence.
 */
export function interpretConsent(utterance: string): boolean {
  if (REFUSAL.test(utterance)) return false;
  return AGREEMENT.test(utterance);
}

export type CallPhase = "dialling" | "disclosing" | "seeking-consent" | "talking" | "ended";

export interface CallState {
  readonly id: string;
  readonly direction: CallDirection;
  readonly phase: CallPhase;
  /** Region of the other party, for the consent rule. */
  readonly region: string;
  readonly disclosed: boolean;
  readonly recordingConsent: boolean;
  readonly recording: boolean;
  /**
   * The most this call may agree to, in minor units. Bounded before dialling,
   * because a call is not a place to be making that judgement.
   */
  readonly spendCeiling: number;
  readonly currency: string;
}

export interface StartCallOptions {
  readonly id: string;
  readonly direction: CallDirection;
  readonly region: string;
  readonly spendCeiling?: number;
  readonly currency?: string;
}

export function startCall(options: StartCallOptions): CallState {
  return {
    id: options.id,
    direction: options.direction,
    phase: "dialling",
    region: options.region,
    disclosed: false,
    recordingConsent: false,
    recording: false,
    // Zero unless a ceiling was set. A call that can agree to nothing is a call
    // that cannot agree to something expensive by accident.
    spendCeiling: options.spendCeiling ?? 0,
    currency: options.currency ?? "GBP",
  };
}

export type VoiceRefusal = "not-disclosed" | "no-recording-consent" | "over-ceiling" | "call-ended";

export type VoiceDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VoiceRefusal; readonly message: string };

/**
 * Whether the model may be connected to the audio yet.
 *
 * The ordering is the control: disclosure happens first, mechanically, and only
 * then does a model hear or say anything. Connecting first and disclosing
 * "immediately after" is the same thing with the guarantee removed.
 */
export function canSpeak(call: CallState): VoiceDecision {
  if (call.phase === "ended") {
    return { ok: false, reason: "call-ended", message: "That call has ended." };
  }
  if (!call.disclosed) {
    return {
      ok: false,
      reason: "not-disclosed",
      message: "The call has not identified itself as an AI yet.",
    };
  }
  return { ok: true };
}

export function markDisclosed(call: CallState): CallState {
  return { ...call, disclosed: true, phase: "seeking-consent" };
}

/**
 * Record the answer to the recording request.
 *
 * A refusal is sticky for the life of the call. Asking again later, after the
 * person has warmed up, is a pattern with a name and it is not one we want.
 */
export function recordConsent(call: CallState, agreed: boolean): CallState {
  return {
    ...call,
    recordingConsent: agreed,
    recording: agreed,
    phase: "talking",
  };
}

/**
 * Whether the call may be recorded or transcribed.
 *
 * Transcription is covered deliberately. A transcript of a call someone declined
 * to have recorded is a recording with extra steps, and the distinction would
 * not survive being explained to the person who said no.
 */
export function canRecord(call: CallState): VoiceDecision {
  if (!needsRecordingConsent(call.region)) return { ok: true };
  if (call.recordingConsent) return { ok: true };

  return {
    ok: false,
    reason: "no-recording-consent",
    message: "They have not agreed to being recorded, so I am not recording or transcribing.",
  };
}

/**
 * Whether the call may agree to a cost.
 *
 * The ceiling is set before dialling because a call is not a place to be making
 * that judgement: the other party is a professional negotiator, the agent is
 * under time pressure, and "this offer expires when we hang up" is a sentence
 * designed for exactly this moment. Anything above the ceiling is taken away and
 * put to the user, who can think about it.
 */
export function canCommit(call: CallState, amount: number): VoiceDecision {
  if (call.phase === "ended") {
    return { ok: false, reason: "call-ended", message: "That call has ended." };
  }
  if (amount > call.spendCeiling) {
    return {
      ok: false,
      reason: "over-ceiling",
      message: `That is more than I can agree to on this call. I will check and come back to you.`,
    };
  }
  return { ok: true };
}

export function endCall(call: CallState): CallState {
  return { ...call, phase: "ended", recording: false };
}

/* -------------------------------------------------------------------------- */
/* What comes out of a call                                                    */
/* -------------------------------------------------------------------------- */

export const callOutcomeSchema = z.object({
  /** What the other party agreed to, in their words, bounded. */
  summary: z.string().max(1000),
  /** An amount agreed, when one was. */
  agreedAmount: z.number().int().nonnegative().optional(),
  /** A reference number, when one was given. */
  reference: z.string().max(100).optional(),
  /** Whether anything now needs doing. */
  followUpNeeded: z.boolean(),
});

export type CallOutcome = z.infer<typeof callOutcomeSchema>;

export interface CallReport {
  /**
   * Always untrusted. Everything in it was said by someone else, and a call is a
   * channel where an agent is socially engineered in real time by a person who
   * adapts to what is working.
   */
  readonly provenance: Provenance;
  readonly callId: string;
  readonly outcome?: CallOutcome;
  readonly recorded: boolean;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Turn a finished call into a report.
 *
 * The outcome is schema-validated rather than taken as prose, for the same
 * reason mail is: what comes back should be facts a task can act on, not a
 * paragraph that might contain an instruction. And it stays untrusted — "the
 * agent on the phone told me to" is not a justification for anything.
 */
export function reportCall(call: CallState, raw: unknown): CallReport {
  const parsed = callOutcomeSchema.safeParse(raw);

  return {
    provenance: "untrusted",
    callId: call.id,
    outcome: parsed.success ? parsed.data : undefined,
    recorded: call.recording,
    ok: parsed.success,
    error: parsed.success ? undefined : "The call did not produce a usable outcome.",
  };
}

export function explainVoiceRefusal(reason: VoiceRefusal): string {
  switch (reason) {
    case "not-disclosed":
      return "I have to say I am an AI before anything else on a call.";
    case "no-recording-consent":
      return "They did not agree to be recorded.";
    case "over-ceiling":
      return "That is more than I was authorised to agree to on a call.";
    case "call-ended":
      return "The call has ended.";
  }
}
