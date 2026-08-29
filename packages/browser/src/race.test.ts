import { describe, expect, it } from "vitest";
import {
  canEnter,
  checkpoint,
  completeStep,
  expiredRaces,
  explainRaceRefusal,
  finishRace,
  needsKeepalive,
  readiness,
  restore,
  KEEPALIVE_INTERVAL_MS,
  MAX_RACE_DURATION_MS,
  MODEL_DISPLAY,
  READINESS_STEPS,
  type RaceState,
} from "./index.js";

const NOW = 1_700_000_000_000;

function race(overrides: Partial<RaceState> = {}): RaceState {
  return {
    id: "r1",
    workspaceId: "ws-1",
    machineId: "m1",
    taskId: "t1",
    description: "Barbican late show tickets",
    completed: [],
    startedAt: NOW,
    ...overrides,
  };
}

const ready = race({ completed: [...READINESS_STEPS] });

describe("the win is removing everything that is not the click", () => {
  /**
   * A shipped agent lost a drop and reported it as a crash, which misreads the
   * problem: the browser was not too slow, it was doing work at the moment of
   * the drop that should have been done an hour earlier.
   */
  it("requires signing in, the page, details, payment and approval beforehand", () => {
    expect(READINESS_STEPS).toEqual([
      "signed-in",
      "on-page",
      "details-filled",
      "payment-chosen",
      "approval-held",
    ]);
  });

  // Finding out you are not signed in when the button appears is the same as
  // not being there.
  it("says what is still missing, continuously", () => {
    const partial = completeStep(completeStep(race(), "signed-in"), "on-page");
    const state = readiness(partial);

    expect(state.ready).toBe(false);
    expect(state.summary).toContain("your details filled in");
    expect(state.summary).toContain("your go-ahead");
  });

  it("reports ready only when everything is done", () => {
    expect(readiness(ready).ready).toBe(true);
    expect(readiness(ready).summary).toContain("One tap left");
  });

  it("does not double-count a step", () => {
    const once = completeStep(race(), "signed-in");
    expect(completeStep(once, "signed-in").completed).toHaveLength(1);
  });

  it("refuses to enter a race that is not ready", () => {
    const decision = canEnter(race(), "m1", []);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-ready");
  });
});

describe("one session, not twenty", () => {
  /**
   * The difference between "being ready" and "crowding out other buyers" is
   * exactly the number of sessions, and a rule that depends on nobody choosing
   * to run more is not a rule.
   */
  it("refuses a second race for the same thing", () => {
    const existing = race({ id: "r0" });
    const decision = canEnter(ready, "m1", [existing]);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("second-session");
      expect(decision.message).toContain("crowding the queue");
    }
  });

  it("allows a race for something else entirely", () => {
    const other = race({ id: "r0", description: "A different show" });
    expect(canEnter(ready, "m1", [other]).ok).toBe(true);
  });

  it("does not count a race that already finished", () => {
    const done = race({ id: "r0", finishedAt: NOW + 1000, outcome: "won" });
    expect(canEnter(ready, "m1", [done]).ok).toBe(true);
  });

  it("does not count another workspace's race", () => {
    const theirs = race({ id: "r0", workspaceId: "ws-other" });
    expect(canEnter(ready, "m1", [theirs]).ok).toBe(true);
  });

  it("refuses a race entered from the wrong machine", () => {
    const decision = canEnter(ready, "m2", []);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("wrong-machine");
  });

  it("refuses to re-enter a finished race", () => {
    const done = finishRace(ready, "won", NOW + 1000);
    expect(canEnter(done, "m1", []).ok).toBe(false);
    // Finishing twice does not move the outcome.
    expect(finishRace(done, "missed", NOW + 2000).outcome).toBe("won");
  });
});

describe("staying warm without hammering", () => {
  // A race that discovers it was logged out at the moment of the drop has
  // achieved nothing.
  it("touches the page often enough to keep a session alive", () => {
    expect(needsKeepalive(NOW - KEEPALIVE_INTERVAL_MS, NOW)).toBe(true);
    expect(needsKeepalive(NOW - 1000, NOW)).toBe(false);
  });

  /**
   * A machine sitting on a page costs money and holds a seat in whatever queue
   * the site is running. Six hours of waiting is a task that should report back
   * rather than continue silently.
   */
  it("gives up rather than waiting forever", () => {
    const stale = race({ startedAt: NOW - MAX_RACE_DURATION_MS - 1 });
    expect(expiredRaces([stale], NOW)).toHaveLength(1);
    expect(expiredRaces([race()], NOW)).toHaveLength(0);
  });

  it("does not expire a race that already finished", () => {
    const done = race({ startedAt: NOW - MAX_RACE_DURATION_MS - 1, finishedAt: NOW });
    expect(expiredRaces([done], NOW)).toHaveLength(0);
  });
});

describe("surviving a crash", () => {
  const space = { display: MODEL_DISPLAY, viewport: { width: 1440, height: 900 } };

  it("records how far preparation got", () => {
    const point = checkpoint(ready, "https://barbican.example/queue", space, NOW);
    expect(point.completed).toEqual([...READINESS_STEPS]);
    expect(point.url).toContain("barbican.example");
  });

  /**
   * The checkpoint says the agent believed it was signed in. A session can lapse
   * while a worker is dead, so readiness is recomputed rather than trusted.
   */
  it("keeps only the steps a restarted worker could re-verify", () => {
    const point = checkpoint(ready, "https://barbican.example", space, NOW);
    const restored = restore(race(), point, ["signed-in", "on-page"]);

    expect(restored.completed).toEqual(["signed-in", "on-page"]);
    expect(readiness(restored).ready).toBe(false);
  });

  it("comes back with nothing when nothing survived", () => {
    const point = checkpoint(ready, "https://barbican.example", space, NOW);
    expect(restore(race(), point, []).completed).toEqual([]);
  });

  it("has words for every refusal", () => {
    for (const reason of [
      "not-ready",
      "already-finished",
      "second-session",
      "wrong-machine",
    ] as const) {
      expect(explainRaceRefusal(reason).length).toBeGreaterThan(5);
    }
  });
});
