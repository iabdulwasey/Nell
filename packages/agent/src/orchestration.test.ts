import { describe, expect, it } from "vitest";
import {
  activeTasks,
  admit,
  canTransition,
  coalesce,
  DEFAULT_CONCURRENCY,
  isBareReply,
  isTerminal,
  routeMessage,
  runningCount,
  transition,
  type ProgressEvent,
  type Task,
} from "./index.js";

const workspaceId = "personal:abc";
const now = 1_800_000_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    workspaceId,
    label: "Sushi booking",
    status: "running",
    spentAmount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("task lifecycle", () => {
  it("permits sensible transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "blocked-on-user")).toBe(true);
    expect(canTransition("blocked-on-user", "running")).toBe(true);
  });

  // A completed task must not be resurrected, and work must not skip execution.
  it("refuses to resurrect a finished task", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      expect(canTransition(status, "running")).toBe(false);
    }
  });

  it("refuses to jump from queued straight to done", () => {
    expect(canTransition("queued", "done")).toBe(false);
  });

  it("reports a helpful reason when refusing", () => {
    const result = transition(task({ status: "done" }), "running", now + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/done task cannot become running/iu);
  });

  it("stamps updatedAt on a legal transition", () => {
    const result = transition(task({ status: "running" }), "done", now + 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.updatedAt).toBe(now + 5);
  });

  it("classifies terminal states", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("blocked-on-user")).toBe(false);
  });
});

describe("concurrency", () => {
  it("counts only this workspace's running tasks", () => {
    const tasks = [
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "running", workspaceId: "personal:other" }),
      task({ id: "c", status: "queued" }),
    ];
    expect(runningCount(tasks, workspaceId)).toBe(1);
  });

  // Without a cap a burst starves everything, which is how a latency-sensitive
  // task loses to five unrelated jobs.
  it("admits only up to the cap, oldest first", () => {
    const tasks = [
      task({ id: "r1", status: "running" }),
      task({ id: "q1", status: "queued", createdAt: now + 1 }),
      task({ id: "q2", status: "queued", createdAt: now + 2 }),
      task({ id: "q3", status: "queued", createdAt: now + 3 }),
    ];
    const admitted = admit(tasks, workspaceId, DEFAULT_CONCURRENCY);
    expect(admitted.map((t) => t.id)).toEqual(["q1", "q2"]);
  });

  it("admits nothing when the cap is full", () => {
    const tasks = [
      task({ id: "r1", status: "running" }),
      task({ id: "r2", status: "running" }),
      task({ id: "r3", status: "running" }),
      task({ id: "q1", status: "queued" }),
    ];
    expect(admit(tasks, workspaceId, 3)).toHaveLength(0);
  });

  it("lists active tasks and excludes finished ones", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", status: "done" })];
    expect(activeTasks(tasks, workspaceId).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("steering", () => {
  const tasks = [
    task({ id: "sushi", label: "Sushi booking" }),
    task({ id: "flights", label: "Tokyo flights" }),
  ];

  it("routes on a channel thread binding without guessing", () => {
    expect(routeMessage({ text: "any", threadTaskId: "sushi" }, tasks, workspaceId)).toEqual({
      kind: "task",
      taskId: "sushi",
      confidence: "certain",
    });
  });

  it("routes on an explicit reply", () => {
    expect(
      routeMessage({ text: "yes", replyToTaskId: "flights" }, tasks, workspaceId)
    ).toMatchObject({
      taskId: "flights",
      confidence: "certain",
    });
  });

  it("routes on an explicit tag", () => {
    expect(routeMessage({ text: "#sushi yes" }, tasks, workspaceId)).toMatchObject({
      taskId: "sushi",
    });
  });

  it("routes on a distinctive word from the label", () => {
    expect(routeMessage({ text: "make the sushi one 8pm" }, tasks, workspaceId)).toMatchObject({
      taskId: "sushi",
      confidence: "likely",
    });
  });

  it("is not fooled by common words", () => {
    // "book" appears in a label but is a stopword, so this must not match.
    expect(routeMessage({ text: "book something new" }, tasks, workspaceId).kind).toBe(
      "coordinator"
    );
  });

  // Guessing wrong sends someone's "yes" to the wrong purchase.
  it("asks rather than guessing when a bare yes is ambiguous", () => {
    const waiting = [
      task({ id: "sushi", label: "Sushi booking", status: "blocked-on-user" }),
      task({ id: "flights", label: "Tokyo flights", status: "blocked-on-user" }),
    ];
    const result = routeMessage({ text: "yes" }, waiting, workspaceId);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("routes a bare yes when exactly one task is waiting", () => {
    const waiting = [
      task({ id: "sushi", status: "blocked-on-user" }),
      task({ id: "flights", label: "Tokyo flights", status: "running" }),
    ];
    expect(routeMessage({ text: "yes" }, waiting, workspaceId)).toMatchObject({ taskId: "sushi" });
  });

  it("ignores bindings to finished tasks", () => {
    const finished = [task({ id: "sushi", status: "done" })];
    expect(routeMessage({ text: "hi", threadTaskId: "sushi" }, finished, workspaceId).kind).toBe(
      "coordinator"
    );
  });

  it("sends general conversation to the coordinator", () => {
    expect(routeMessage({ text: "what can you do?" }, tasks, workspaceId).kind).toBe("coordinator");
  });

  it("recognises bare replies", () => {
    for (const text of ["yes", "Yeah!", "ok", "no", "cancel"]) {
      expect(isBareReply(text)).toBe(true);
    }
    expect(isBareReply("yes, book the 8pm one")).toBe(false);
  });
});

describe("progress coalescing", () => {
  function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
    return {
      taskId: "sushi",
      label: "Sushi",
      emoji: "🍣",
      message: "searching",
      at: now,
      ...overrides,
    };
  }

  it("delivers interrupts immediately", () => {
    const result = coalesce([event({ interrupt: true, message: "approve $240?" })], now);
    expect(result.immediate).toHaveLength(1);
    expect(result.digest).toBeUndefined();
  });

  // Delivering every progress event is how an assistant becomes a firehose.
  it("holds routine updates until the window closes", () => {
    const result = coalesce([event()], now + 1000);
    expect(result.immediate).toHaveLength(0);
    expect(result.digest).toBeUndefined();
    expect(result.pending).toHaveLength(1);
  });

  it("emits one digest once the window closes", () => {
    const events = [
      event({ taskId: "sushi", label: "Sushi", message: "found 3" }),
      event({ taskId: "flights", label: "Flights", emoji: "✈️", message: "still searching" }),
    ];
    const result = coalesce(events, now + 61_000);
    expect(result.digest).toContain("Sushi: found 3");
    expect(result.digest).toContain("Flights: still searching");
    expect(result.pending).toHaveLength(0);
  });

  // Nobody needs three updates about the same job.
  it("keeps only the newest update per task", () => {
    const events = [
      event({ message: "searching", at: now }),
      event({ message: "found a table", at: now + 500 }),
    ];
    const result = coalesce(events, now + 61_000);
    expect(result.digest).toContain("found a table");
    expect(result.digest).not.toContain("searching");
  });

  it("mixes an immediate interrupt with a held digest", () => {
    const result = coalesce(
      [
        event({ interrupt: true, message: "approve?" }),
        event({ taskId: "flights", label: "Flights" }),
      ],
      now + 1000
    );
    expect(result.immediate).toHaveLength(1);
    expect(result.pending).toHaveLength(1);
  });

  it("returns nothing for no events", () => {
    expect(coalesce([], now)).toEqual({ immediate: [], pending: [] });
  });
});
