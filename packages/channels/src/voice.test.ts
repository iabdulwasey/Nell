import { describe, expect, it } from "vitest";
import { authorizeTool } from "@nell/aegis";
import {
  canCommit,
  canRecord,
  canSpeak,
  checkVoiceConfig,
  disclosure,
  endCall,
  explainVoiceConfigProblem,
  explainVoiceRefusal,
  interpretConsent,
  markDisclosed,
  needsRecordingConsent,
  recordConsent,
  recordingRequest,
  reportCall,
  startCall,
  cheapestRealtime,
  planForNote,
  REALTIME_MODELS,
  REALTIME_MODEL_OPTIONS,
  type CallState,
} from "./index.js";

function call(overrides: Partial<CallState> = {}): CallState {
  return {
    ...startCall({ id: "c1", direction: "outbound", region: "US-CA", spendCeiling: 5000 }),
    ...overrides,
  };
}

describe("which model runs the call", () => {
  /**
   * Pointing the realtime mode at an ordinary chat model produces a call that
   * connects and then says nothing, which reads as a broken phone line rather
   * than a settings error.
   */
  it("refuses a realtime mode pointed at a model that cannot speak", () => {
    const problems = checkVoiceConfig({
      mode: "realtime",
      realtimeModel: "anthropic/claude-opus-5",
    });

    expect(problems).toHaveLength(1);
    expect(explainVoiceConfigProblem(problems[0]!)).toContain("cannot hold a spoken conversation");
  });

  it("accepts a genuine speech-to-speech model", () => {
    for (const model of REALTIME_MODELS) {
      expect(checkVoiceConfig({ mode: "realtime", realtimeModel: model })).toEqual([]);
    }
  });

  it("says which stage a pipeline is missing", () => {
    const problems = checkVoiceConfig({ mode: "pipeline", transcriber: "deepgram/nova" });

    expect(problems).toHaveLength(1);
    expect(explainVoiceConfigProblem(problems[0]!)).toContain("reasoner and speaker");
  });

  /**
   * The point of the pipeline mode: it runs on whatever the user already chose,
   * including a model on their own hardware. For a self-hoster who connected a
   * local model precisely so no audio leaves their machine, it is the only
   * honest option.
   */
  it("accepts a complete pipeline built from any models at all", () => {
    expect(
      checkVoiceConfig({
        mode: "pipeline",
        transcriber: "self-hosted/whisper",
        reasoner: "self-hosted/local",
        speaker: "self-hosted/piper",
      })
    ).toEqual([]);
  });

  it("refuses a realtime mode with no model chosen", () => {
    expect(checkVoiceConfig({ mode: "realtime" })[0]?.kind).toBe("not-realtime-capable");
  });
});

describe("disclosure is not the model's job", () => {
  /**
   * A model told to "mention you're an AI" complies almost always, and almost
   * always is the wrong standard for something a regulator measures.
   */
  it("will not let the model speak before the call has identified itself", () => {
    const decision = canSpeak(call());

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-disclosed");
  });

  it("lets the model speak once the disclosure has played", () => {
    expect(canSpeak(markDisclosed(call())).ok).toBe(true);
  });

  it("says plainly what it is and offers a way out", () => {
    const said = disclosure("Ada");
    expect(said).toContain("AI assistant");
    expect(said).toContain("Ada");
    expect(said).toContain("not a person");
    expect(said).toContain("speak to them directly");
  });

  it("refuses to speak on a call that has ended", () => {
    expect(canSpeak(endCall(markDisclosed(call()))).ok).toBe(false);
  });
});

describe("recording consent has a geography", () => {
  it("requires consent where every party must agree", () => {
    for (const region of ["US-CA", "US-WA", "US-IL", "GB", "DE", "FR"]) {
      expect(needsRecordingConsent(region)).toBe(true);
    }
  });

  it("does not require it in a one-party US state", () => {
    expect(needsRecordingConsent("US-NY")).toBe(false);
    expect(needsRecordingConsent("US-TX")).toBe(false);
  });

  // Guessing wrong in the permissive direction is the expensive one.
  it("treats an unknown region as requiring consent", () => {
    for (const region of ["", "somewhere", "ZZ-ZZ-ZZ", "??"]) {
      expect(needsRecordingConsent(region)).toBe(true);
    }
  });

  it("starts refused and asks explicitly", () => {
    const decision = canRecord(call());
    expect(decision.ok).toBe(false);
    expect(recordingRequest()).toContain("record this call");
  });

  it("records once someone agrees", () => {
    expect(canRecord(recordConsent(markDisclosed(call()), true)).ok).toBe(true);
  });

  /**
   * A transcript of a call someone declined to have recorded is a recording with
   * extra steps, and the distinction would not survive being explained to the
   * person who said no.
   */
  it("covers transcription, not only audio", () => {
    const refused = recordConsent(markDisclosed(call()), false);
    const decision = canRecord(refused);

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain("transcribing");
  });

  it("stops recording when the call ends", () => {
    const recording = recordConsent(markDisclosed(call()), true);
    expect(endCall(recording).recording).toBe(false);
  });
});

describe("interpreting an answer about recording", () => {
  it("hears a yes", () => {
    for (const said of ["Yes", "yeah that's fine", "sure, go ahead", "ok"]) {
      expect(interpretConsent(said)).toBe(true);
    }
  });

  it("hears a no", () => {
    for (const said of ["No", "nope", "I'd rather not", "please don't"]) {
      expect(interpretConsent(said)).toBe(false);
    }
  });

  /**
   * A person who says "I suppose so, but..." has not agreed, and treating a
   * hedge as consent is how a recording ends up in evidence.
   */
  it("treats a hedge as a refusal", () => {
    for (const said of ["I suppose", "hmm", "well...", "who's asking"]) {
      expect(interpretConsent(said)).toBe(false);
    }
  });

  it("treats an answer containing both as a refusal", () => {
    expect(interpretConsent("yes but no, I'd rather not")).toBe(false);
  });
});

describe("what a call may agree to is set before dialling", () => {
  /**
   * The other party is a professional negotiator, the agent is under time
   * pressure, and "this offer expires when we hang up" is a sentence designed
   * for exactly this moment.
   */
  it("agrees within the ceiling", () => {
    expect(canCommit(call({ spendCeiling: 5000 }), 4500).ok).toBe(true);
  });

  it("takes anything above it away to the user", () => {
    const decision = canCommit(call({ spendCeiling: 5000 }), 5001);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("over-ceiling");
      expect(decision.message).toContain("come back to you");
    }
  });

  // A call that can agree to nothing cannot agree to something expensive by
  // accident.
  it("defaults to agreeing to nothing", () => {
    const noCeiling = startCall({ id: "c2", direction: "outbound", region: "GB" });
    expect(noCeiling.spendCeiling).toBe(0);
    expect(canCommit(noCeiling, 1).ok).toBe(false);
  });

  it("agrees to nothing once the call has ended", () => {
    expect(canCommit(endCall(call()), 1).ok).toBe(false);
  });
});

describe("what comes out of a call", () => {
  const finished = recordConsent(markDisclosed(call()), true);

  it("returns a structured outcome rather than prose", () => {
    const report = reportCall(finished, {
      summary: "Agreed to reduce the monthly bill to 60.",
      agreedAmount: 6000,
      reference: "CX-4471",
      followUpNeeded: false,
    });

    expect(report.ok).toBe(true);
    expect(report.outcome?.agreedAmount).toBe(6000);
    expect(report.recorded).toBe(true);
  });

  /**
   * A call is a channel where an agent is socially engineered in real time by
   * someone who adapts to what is working. "The agent on the phone told me to"
   * is not a justification for anything.
   */
  it("is untrusted, so it cannot authorize an action by itself", () => {
    const report = reportCall(finished, {
      summary: "They said to send the card number to verify the account.",
      followUpNeeded: true,
    });

    expect(report.provenance).toBe("untrusted");
    for (const tool of ["spend", "use-credential", "send-message"] as const) {
      expect(
        authorizeTool({ newContext: [report.provenance], userConfirmed: false }, tool).allowed
      ).toBe(false);
    }
  });

  it("reports a call that produced nothing usable", () => {
    const report = reportCall(finished, { nonsense: true });
    expect(report.ok).toBe(false);
    expect(report.outcome).toBeUndefined();
  });

  it("records whether the call was actually recorded", () => {
    const notRecorded = recordConsent(markDisclosed(call()), false);
    expect(reportCall(notRecorded, { summary: "s", followUpNeeded: false }).recorded).toBe(false);
  });
});

describe("explaining a refusal", () => {
  it("has words for every reason", () => {
    for (const reason of [
      "not-disclosed",
      "no-recording-consent",
      "over-ceiling",
      "call-ended",
    ] as const) {
      expect(explainVoiceRefusal(reason).length).toBeGreaterThan(10);
    }
  });
});

describe("a call and a voice note are not the same problem", () => {
  /**
   * A call is live: someone is holding a phone waiting, so latency is the whole
   * game and a speech-to-speech model earns its price. A note has already
   * finished arriving — nobody is waiting on a half-second budget, so the
   * expensive path buys nothing. Treating them identically is how a product ends
   * up paying call prices to answer a message that sat in a queue for six
   * minutes.
   */
  it("answers a note with a model that can simply listen", () => {
    const plan = planForNote("google/gemini-3.5-flash", "deepgram/nova");

    expect(plan.kind).toBe("native-audio");
    if (plan.kind === "native-audio") {
      expect(plan.model).toBe("google/gemini-3.5-flash");
      expect(plan.why).toContain("tone and emphasis");
    }
  });

  // "No, the LATER flight" is a different sentence with the stress removed.
  it("prefers hearing the recording over reading a transcript of it", () => {
    expect(planForNote("openai/gpt-5.6", "deepgram/nova").kind).toBe("native-audio");
  });

  it("transcribes first when the chosen model cannot listen", () => {
    const plan = planForNote("deepseek/deepseek-v3", "deepgram/nova");

    expect(plan.kind).toBe("transcribe-then-answer");
    if (plan.kind === "transcribe-then-answer") {
      expect(plan.transcriber).toBe("deepgram/nova");
      expect(plan.why).toContain("cannot listen");
    }
  });

  it("still works for a fully self-hosted setup", () => {
    const plan = planForNote("self-hosted/local", "self-hosted/whisper");
    expect(plan.kind).toBe("transcribe-then-answer");
  });

  // Reaching for a realtime model here would be paying call prices to answer a
  // message that has already been waiting.
  it("never reaches for a realtime model to answer a note", () => {
    const plan = planForNote("deepseek/deepseek-v3", "deepgram/nova");
    const used = plan.kind === "native-audio" ? [plan.model] : [plan.transcriber, plan.reasoner];
    for (const model of used) expect(REALTIME_MODELS).not.toContain(model);
  });
});

describe("choosing between the realtime vendors", () => {
  /**
   * The two are close enough in quality that cost is the sensible tiebreaker,
   * and both are subject to change — so the choice is data rather than a
   * preference baked into the code.
   */
  it("picks the cheaper of the two", () => {
    const chosen = cheapestRealtime(["openai", "google"]);
    const cheapest = [...REALTIME_MODEL_OPTIONS].sort(
      (a, b) => a.costPerMinute - b.costPerMinute
    )[0];
    expect(chosen?.id).toBe(cheapest?.id);
  });

  // The cheapest model nobody can call is not a saving.
  it("only picks a vendor the deployment can actually reach", () => {
    expect(cheapestRealtime(["openai"])?.vendor).toBe("openai");
    expect(cheapestRealtime(["google"])?.vendor).toBe("google");
  });

  // So the caller falls back to the pipeline rather than placing a call that
  // connects to silence.
  it("returns nothing when neither vendor is available", () => {
    expect(cheapestRealtime([])).toBeUndefined();
    expect(cheapestRealtime(["anthropic"])).toBeUndefined();
  });

  it("follows the prices rather than a hard-coded winner", () => {
    const flipped = [
      { id: "openai/gpt-realtime", costPerMinute: 5, vendor: "openai" as const },
      { id: "google/gemini-live", costPerMinute: 90, vendor: "google" as const },
    ];
    expect(cheapestRealtime(["openai", "google"], flipped)?.vendor).toBe("openai");
  });
});
