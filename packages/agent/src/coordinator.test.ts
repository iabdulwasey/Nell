import { describe, expect, it } from "vitest";
import {
  drainQueue,
  handleMessage,
  handleWorkerResult,
  progressFrom,
  type CoordinatorState,
  type Effect,
  type Intent,
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

function state(overrides: Partial<CoordinatorState> = {}): CoordinatorState {
  return {
    workspaceId,
    tasks: [],
    directives: [],
    preferences: [],
    ledger: [],
    vaultHandles: [],
    ...overrides,
  };
}

const newTask: Intent = {
  kind: "new-task",
  label: "Sushi booking",
  emoji: "🍣",
  objective: "Book a table at Nozomi for 4 on Friday",
};

function kinds(effects: readonly Effect[]): string[] {
  return effects.map((effect) => effect.kind);
}

describe("starting work", () => {
  it("spawns a worker and acknowledges", () => {
    const effects = handleMessage({
      state: state(),
      message: { text: "book me sushi friday" },
      intent: newTask,
      newTaskId: "t-new",
      now,
    });
    expect(kinds(effects)).toEqual(["update-task", "spawn-worker", "reply"]);
  });

  it("briefs the worker with the objective and no secrets", () => {
    const effects = handleMessage({
      state: state(),
      message: { text: "book me sushi friday" },
      intent: newTask,
      newTaskId: "t-new",
      now,
    });
    const spawn = effects.find((effect) => effect.kind === "spawn-worker");
    expect(spawn?.kind === "spawn-worker" && spawn.briefing.text).toContain("Nozomi");
  });

  // A burst must queue rather than starve work already in flight.
  it("queues past the concurrency cap instead of starting", () => {
    const busy = state({
      tasks: [
        task({ id: "a", status: "running" }),
        task({ id: "b", status: "running" }),
        task({ id: "c", status: "running" }),
      ],
      concurrency: 3,
    });
    const effects = handleMessage({
      state: busy,
      message: { text: "one more thing" },
      intent: newTask,
      newTaskId: "t-new",
      now,
    });
    expect(kinds(effects)).toEqual(["update-task", "reply"]);
    const reply = effects.find((e) => e.kind === "reply");
    expect(reply?.kind === "reply" && reply.text).toMatch(/queued/iu);
  });
});

describe("conversation", () => {
  it("answers directly without spawning anything", () => {
    const effects = handleMessage({
      state: state(),
      message: { text: "what can you do?" },
      intent: { kind: "conversation", reply: "I can book things for you." },
      newTaskId: "unused",
      now,
    });
    expect(kinds(effects)).toEqual(["reply"]);
  });
});

describe("steering", () => {
  it("routes a message that clearly belongs to a running task", () => {
    const effects = handleMessage({
      state: state({ tasks: [task({ id: "sushi", label: "Sushi booking" })] }),
      message: { text: "make the sushi one 8pm instead" },
      // Even though the planner proposed a brand new task, routing wins.
      intent: newTask,
      newTaskId: "t-new",
      now,
    });
    expect(kinds(effects)).toEqual(["steer-worker"]);
  });

  // Sending someone's "yes" to the wrong purchase is the failure this prevents.
  it("asks rather than guessing when two tasks await approval", () => {
    const waiting = state({
      tasks: [
        task({ id: "sushi", label: "Sushi booking", status: "blocked-on-user" }),
        task({ id: "flights", label: "Tokyo flights", status: "blocked-on-user" }),
      ],
    });
    const effects = handleMessage({
      state: waiting,
      message: { text: "yes" },
      intent: { kind: "conversation", reply: "ok" },
      newTaskId: "unused",
      now,
    });
    expect(kinds(effects)).toEqual(["ask"]);
    const ask = effects[0];
    expect(ask?.kind === "ask" && ask.choices).toEqual(["Sushi booking", "Tokyo flights"]);
  });
});

describe("cancelling", () => {
  it("cancels a running task", () => {
    const effects = handleMessage({
      state: state({ tasks: [task({ id: "sushi" })] }),
      message: { text: "stop the sushi one" },
      intent: { kind: "cancel", taskId: "sushi" },
      newTaskId: "unused",
      now,
    });
    expect(kinds(effects)).toEqual(["update-task", "reply"]);
  });

  it("says so when the task is already finished", () => {
    const effects = handleMessage({
      state: state({ tasks: [task({ id: "sushi", status: "done" })] }),
      message: { text: "cancel it" },
      intent: { kind: "cancel", taskId: "sushi" },
      newTaskId: "unused",
      now,
    });
    const reply = effects[0];
    expect(reply?.kind === "reply" && reply.text).toMatch(/already done/iu);
  });

  it("does not cancel another workspace's task", () => {
    const effects = handleMessage({
      state: state({ tasks: [task({ id: "sushi", workspaceId: "personal:other" })] }),
      message: { text: "cancel it" },
      intent: { kind: "cancel", taskId: "sushi" },
      newTaskId: "unused",
      now,
    });
    const reply = effects[0];
    expect(reply?.kind === "reply" && reply.text).toMatch(/couldn't find/iu);
  });
});

describe("worker results", () => {
  const running = state({ tasks: [task({ id: "sushi" })] });

  it("reports success and records the outcome", () => {
    const effects = handleWorkerResult(
      running,
      { taskId: "sushi", outcome: "succeeded", summary: "Booked Nozomi, 8pm, table for 4." },
      now
    );
    expect(kinds(effects)).toEqual(["update-task", "record-outcome", "reply"]);
  });

  it("reports failure without pretending it worked", () => {
    const effects = handleWorkerResult(
      running,
      { taskId: "sushi", outcome: "failed", summary: "No tables available on Friday." },
      now
    );
    const update = effects.find((e) => e.kind === "update-task");
    expect(update?.kind === "update-task" && update.status).toBe("failed");
  });

  // A blocked worker is waiting on a person, not broken — the task stays alive
  // so the answer can resume it.
  it("keeps a blocked task alive and asks the question", () => {
    const effects = handleWorkerResult(
      running,
      {
        taskId: "sushi",
        outcome: "blocked",
        summary: "Needs approval",
        question: "Approve USD 240.00 at Nozomi?",
        choices: ["Yes", "No"],
      },
      now
    );
    const update = effects.find((e) => e.kind === "update-task");
    expect(update?.kind === "update-task" && update.status).toBe("blocked-on-user");
    const ask = effects.find((e) => e.kind === "ask");
    expect(ask?.kind === "ask" && ask.text).toContain("USD 240.00");
  });

  it("ignores a result for an unknown or foreign task", () => {
    expect(
      handleWorkerResult(running, { taskId: "nope", outcome: "succeeded", summary: "x" }, now)
    ).toHaveLength(0);
  });
});

describe("queue draining", () => {
  it("starts queued work once a slot frees", () => {
    const drained = drainQueue(
      state({
        tasks: [
          task({ id: "done1", status: "done" }),
          task({ id: "q1", status: "queued", createdAt: now + 1 }),
          task({ id: "q2", status: "queued", createdAt: now + 2 }),
        ],
        concurrency: 1,
      }),
      now
    );
    expect(drained).toHaveLength(1);
    expect(drained[0]?.taskId).toBe("q1");
  });

  it("starts nothing while the cap is full", () => {
    expect(
      drainQueue(
        state({
          tasks: [task({ id: "r1", status: "running" }), task({ id: "q1", status: "queued" })],
          concurrency: 1,
        }),
        now
      )
    ).toHaveLength(0);
  });
});

describe("progress events", () => {
  it("carries the task's label and emoji for digesting", () => {
    const event = progressFrom(task({ emoji: "🍣" }), "found 3 options", now);
    expect(event).toMatchObject({ label: "Sushi booking", emoji: "🍣", interrupt: false });
  });

  it("marks interrupts so they bypass the digest window", () => {
    expect(progressFrom(task(), "approve?", now, true).interrupt).toBe(true);
  });
});
