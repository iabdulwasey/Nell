/**
 * Race mode: being ready before the thing happens.
 *
 * A ticket drop lasts seconds. A shipped agent lost one to a human and reported
 * it as a crash, which misreads the problem — the browser was not too slow, it
 * was doing work at the moment of the drop that should have been done an hour
 * earlier.
 *
 * So the win here is not speed. It is **removing everything that is not the
 * click**. Logged in already, on the page already, form filled already, payment
 * chosen already, approval granted already. When the button appears there is one
 * action left, and one action is fast whatever it is running on.
 *
 * A line worth stating, because this is the feature where it would be easy to
 * cross without noticing: **one session, no queue-jumping, no parallel
 * identities.** A person using an assistant to be ready on time is doing what
 * anyone with a fast connection and a free afternoon does. Running twenty
 * sessions to crowd out other buyers is a different activity with a different
 * name, and this deliberately cannot do it — a race is bound to a single machine
 * and refuses to start a second.
 */

import type { CoordinateSpace } from "./computer.js";

export type ReadinessStep =
  | "signed-in"
  | "on-page"
  | "details-filled"
  | "payment-chosen"
  | "approval-held";

/** Everything that must be true before a race is worth entering. */
export const READINESS_STEPS: readonly ReadinessStep[] = [
  "signed-in",
  "on-page",
  "details-filled",
  "payment-chosen",
  "approval-held",
];

export interface RaceState {
  readonly id: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly taskId: string;
  /** What the race is waiting for, in the user's words. */
  readonly description: string;
  readonly completed: readonly ReadinessStep[];
  /** When the drop is expected, when that is known. */
  readonly expectedAt?: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly outcome?: "won" | "missed" | "abandoned";
}

export interface Readiness {
  readonly ready: boolean;
  readonly missing: readonly ReadinessStep[];
  /** What the user is told while waiting. */
  readonly summary: string;
}

const STEP_WORDS: Readonly<Record<ReadinessStep, string>> = {
  "signed-in": "signed in",
  "on-page": "on the page",
  "details-filled": "your details filled in",
  "payment-chosen": "a payment method ready",
  "approval-held": "your go-ahead",
};

/**
 * How ready the race is.
 *
 * Reported continuously rather than checked at the moment of the drop. Finding
 * out you are not signed in when the button appears is the same as not being
 * there, and the whole point is to have discovered it an hour earlier.
 */
export function readiness(state: RaceState): Readiness {
  const missing = READINESS_STEPS.filter((step) => !state.completed.includes(step));

  if (missing.length === 0) {
    return {
      ready: true,
      missing,
      summary: `Ready and waiting for ${state.description}. One tap left when it appears.`,
    };
  }

  return {
    ready: false,
    missing,
    summary: `Not ready yet for ${state.description} — still need ${missing
      .map((step) => STEP_WORDS[step])
      .join(", ")}.`,
  };
}

export function completeStep(state: RaceState, step: ReadinessStep): RaceState {
  return state.completed.includes(step)
    ? state
    : { ...state, completed: [...state.completed, step] };
}

export type RaceRefusal = "not-ready" | "already-finished" | "second-session" | "wrong-machine";

export type RaceDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RaceRefusal; readonly message: string };

/**
 * Whether a race may be entered on this machine.
 *
 * The single-session rule lives here. It is enforced rather than documented
 * because the difference between "being ready" and "crowding out other buyers"
 * is exactly the number of sessions, and a rule that depends on nobody choosing
 * to run more is not a rule.
 */
export function canEnter(
  state: RaceState,
  machineId: string,
  existingRaces: readonly RaceState[]
): RaceDecision {
  if (state.finishedAt !== undefined) {
    return { ok: false, reason: "already-finished", message: "That race is over." };
  }
  if (state.machineId !== machineId) {
    return {
      ok: false,
      reason: "wrong-machine",
      message: "That race belongs to a different computer.",
    };
  }

  const others = existingRaces.filter(
    (race) =>
      race.id !== state.id &&
      race.finishedAt === undefined &&
      race.description === state.description &&
      race.workspaceId === state.workspaceId
  );
  if (others.length > 0) {
    return {
      ok: false,
      reason: "second-session",
      message:
        "I am already waiting for that on one machine. Running a second would be crowding the queue rather than being ready for it.",
    };
  }

  const state_readiness = readiness(state);
  if (!state_readiness.ready) {
    return { ok: false, reason: "not-ready", message: state_readiness.summary };
  }

  return { ok: true };
}

export function finishRace(
  state: RaceState,
  outcome: NonNullable<RaceState["outcome"]>,
  now: number
): RaceState {
  return state.finishedAt === undefined ? { ...state, outcome, finishedAt: now } : state;
}

/* -------------------------------------------------------------------------- */
/* Staying warm                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How often to touch the page so the session does not lapse.
 *
 * Sites time out an idle session, and a race that discovers it was logged out at
 * the moment of the drop has achieved nothing. Frequent enough to stay alive,
 * infrequent enough not to look like a script hammering the page — which it is
 * not, and should not resemble.
 */
export const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;

/** After this long with no drop, the race is abandoned rather than left running. */
export const MAX_RACE_DURATION_MS = 6 * 60 * 60 * 1000;

export function needsKeepalive(lastTouchedAt: number, now: number): boolean {
  return now - lastTouchedAt >= KEEPALIVE_INTERVAL_MS;
}

/**
 * Races that have waited long enough.
 *
 * A machine sitting on a page costs money and holds a seat in whatever queue the
 * site is running. Six hours of waiting for a drop that did not come is a task
 * that should report back rather than continue silently.
 */
export function expiredRaces(races: readonly RaceState[], now: number): readonly RaceState[] {
  return races.filter(
    (race) => race.finishedAt === undefined && now - race.startedAt >= MAX_RACE_DURATION_MS
  );
}

/* -------------------------------------------------------------------------- */
/* Surviving a crash                                                           */
/* -------------------------------------------------------------------------- */

export interface RaceCheckpoint {
  readonly raceId: string;
  readonly machineId: string;
  readonly completed: readonly ReadinessStep[];
  readonly url: string;
  readonly space: CoordinateSpace;
  readonly at: number;
}

/**
 * What has to survive a worker dying.
 *
 * The machine keeps the session — that is what a persistent machine is for — so
 * a checkpoint only needs to record how far the preparation got. A restarted
 * worker resumes on a browser that is still signed in and still on the page,
 * which is the difference between losing thirty seconds and losing the race.
 */
export function checkpoint(
  state: RaceState,
  url: string,
  space: CoordinateSpace,
  now: number
): RaceCheckpoint {
  return {
    raceId: state.id,
    machineId: state.machineId,
    completed: state.completed,
    url,
    space,
    at: now,
  };
}

/**
 * Restore a race from its checkpoint.
 *
 * Readiness is recomputed rather than trusted: the checkpoint says the agent
 * believed it was signed in, and a session can lapse while a worker is dead. The
 * steps that survive are the ones a restarted worker can re-verify cheaply, and
 * the rest are re-done.
 */
export function restore(
  state: RaceState,
  point: RaceCheckpoint,
  stillValid: readonly ReadinessStep[]
): RaceState {
  return {
    ...state,
    completed: point.completed.filter((step) => stillValid.includes(step)),
  };
}

export function explainRaceRefusal(reason: RaceRefusal): string {
  switch (reason) {
    case "not-ready":
      return "Not everything is in place yet.";
    case "already-finished":
      return "That race is over.";
    case "second-session":
      return "I am already waiting for that on one machine.";
    case "wrong-machine":
      return "That race belongs to a different computer.";
  }
}
