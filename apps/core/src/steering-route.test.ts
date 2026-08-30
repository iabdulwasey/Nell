/**
 * What a message means while a task is running.
 *
 * The loop used to treat every message from that workspace as a correction to
 * the running task, unconditionally. So asking "what's the weather?" during a
 * flight booking pushed the weather question into the booking: the request was
 * lost, and the task was told something irrelevant. Nobody notices, because a
 * steered task carries on and the reply that never came looks like slowness.
 *
 * `routeMessage` was written in v1 to decide exactly this and was reachable
 * from nothing but a coordinator that nothing imported. These assert the
 * decisions the loop now depends on — kept here rather than in the package
 * because what matters is the *shape the loop passes in*: one running task, no
 * thread binding, no reply linkage, which is what Telegram's flat thread gives.
 */

import { routeMessage, type Task } from "@nell/agent";
import { describe, expect, it } from "vitest";

const WORKSPACE = "personal:test";

const runningTask = (label: string, status: Task["status"] = "running"): Task => ({
  id: "task-1",
  workspaceId: WORKSPACE,
  label,
  status,
  spentAmount: 0,
  createdAt: 0,
  updatedAt: 0,
});

const route = (text: string, task: Task) => routeMessage({ text }, [task], WORKSPACE).kind;

describe("a message arriving mid-task", () => {
  const booking = runningTask("book a flight to Delhi on 3 September");

  /**
   * The case that was broken, and the reason for all of this.
   */
  it("is a new request when it has nothing to do with the task", () => {
    expect(route("what's the weather in Bristol?", booking)).toBe("coordinator");
    expect(route("remind me to call the dentist", booking)).toBe("coordinator");
  });

  it("is a correction when it names the thing being done", () => {
    expect(route("make that Delhi on the 4th instead", booking)).toBe("task");
    expect(route("use the flight that arrives earliest", runningTask("find me a flight"))).toBe(
      "task"
    );
  });

  /**
   * A bare "yes" is only an answer if something asked a question.
   *
   * Against a task that is merely *running*, it is not a correction — there is
   * nothing to confirm, and reading it as one is how a stray "ok" changes what
   * a task is doing.
   */
  it("is not a correction when a bare reply has nothing to answer", () => {
    expect(route("yes", booking)).toBe("coordinator");
  });

  it("is a correction when a bare reply answers a task that asked", () => {
    expect(route("yes", runningTask("buy the tickets", "blocked-on-user"))).toBe("task");
  });

  /**
   * An explicit tag beats every heuristic, which is what makes the ambiguity
   * escape hatch usable: when Nell asks "is that about X or something new?",
   * `#book` is an unambiguous answer.
   */
  it("obeys an explicit tag", () => {
    expect(route("#book make it Thursday", booking)).toBe("task");
  });

  /** A finished task is not steerable — its label must not capture a message. */
  it("does not route to a task that has already finished", () => {
    expect(route("make that the 4th instead", runningTask("book a flight", "done"))).toBe(
      "coordinator"
    );
  });
});
