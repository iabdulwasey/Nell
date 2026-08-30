/**
 * A thread of its own for each task.
 *
 * The structural answer to the single most documented complaint about this kind
 * of product: with three tasks running, one flat conversation interleaves three
 * and the reader has to sort them out. The `[label]` prefix was always a
 * workaround for not having threads.
 *
 * What these mostly pin down is the **degradation**, because that is where a
 * feature like this breaks a working product. Telegram allows forum topics only
 * in a forum-enabled supergroup, so a private chat with the bot never gets one —
 * and it must keep behaving exactly as it did rather than failing because a
 * group setting is off.
 */

import { describe, expect, it } from "vitest";
import { closeForumTopic, openForumTopic, sendDocument, sendMessage } from "./telegram-poll.js";

const ok = (body: unknown) =>
  ({ ok: true, json: async () => body, text: async () => "" }) as unknown as Response;

const refused = () =>
  ({ ok: false, status: 400, json: async () => ({}), text: async () => "" }) as unknown as Response;

describe("opening a thread", () => {
  it("returns the thread Telegram made", async () => {
    const id = await openForumTopic({
      token: "t",
      chatId: "-100123",
      title: "Book 2 seats",
      fetchImpl: (async () => ok({ ok: true, result: { message_thread_id: 42 } })) as typeof fetch,
    });
    expect(id).toBe(42);
  });

  /** A private chat, which is where this agent actually lives most of the time. */
  it("returns nothing when the chat cannot have threads", async () => {
    const id = await openForumTopic({
      token: "t",
      chatId: "555",
      title: "x",
      fetchImpl: (async () => refused()) as typeof fetch,
    });
    expect(id).toBeUndefined();
  });

  /** A network failure must not take a task down with it. */
  it("returns nothing rather than throwing when the call fails", async () => {
    const id = await openForumTopic({
      token: "t",
      chatId: "555",
      title: "x",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(id).toBeUndefined();
  });

  it("keeps the title inside Telegram's limit", async () => {
    let sent: Record<string, unknown> = {};
    await openForumTopic({
      token: "t",
      chatId: "-100123",
      title: "x".repeat(400),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return ok({ ok: true, result: { message_thread_id: 1 } });
      }) as unknown as typeof fetch,
    });
    expect(String(sent["name"]).length).toBe(128);
  });
});

describe("sending into a thread", () => {
  it("addresses the task's own thread when it has one", async () => {
    const bodies: Record<string, unknown>[] = [];
    await sendMessage({
      token: "t",
      chatId: "-100123",
      topicId: 42,
      text: "found three",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return ok({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(bodies[0]?.["message_thread_id"]).toBe(42);
  });

  /**
   * The field must be *absent*, not present-and-undefined: Telegram rejects a
   * null thread id, and the failure is a silent 400 on a reply someone is
   * waiting for.
   */
  it("omits the field entirely in a chat with no threads", async () => {
    const bodies: Record<string, unknown>[] = [];
    await sendMessage({
      token: "t",
      chatId: "555",
      text: "found three",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return ok({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(bodies[0]).not.toHaveProperty("message_thread_id");
  });

  it("puts a file in the thread that produced it", async () => {
    let form: FormData | undefined;
    await sendDocument({
      token: "t",
      chatId: "-100123",
      topicId: 42,
      path: "package.json",
      name: "package.json",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        form = init.body as FormData;
        return ok({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(form?.get("message_thread_id")).toBe("42");
  });
});

describe("closing", () => {
  it("does not throw when Telegram refuses", async () => {
    await expect(
      closeForumTopic({
        token: "t",
        chatId: "-100123",
        topicId: 42,
        fetchImpl: (async () => {
          throw new Error("gone");
        }) as typeof fetch,
      })
    ).resolves.toBeUndefined();
  });
});
