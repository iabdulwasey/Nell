import { describe, expect, it } from "vitest";
import { authorizeTool } from "@nell/aegis";
import {
  applyChange,
  describePlan,
  likelyMisfiled,
  mailOperationSchema,
  planChange,
  undoChange,
  BULK_APPROVAL_THRESHOLD,
  MAX_BATCH,
  type EmailMessage,
  type MailChange,
  type MailQuery,
  type MailWriteProvider,
} from "./index.js";

const NOW = 1_700_000_000_000;

function message(id: string, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    from: "newsletter@shop.example",
    to: ["ada@example.com"],
    subject: `Newsletter ${id}`,
    body: "Sale ends Friday.",
    receivedAt: NOW,
    unread: true,
    ...overrides,
  };
}

class FakeMail implements MailWriteProvider {
  readonly name = "fake";
  messages: EmailMessage[] = [message("1"), message("2"), message("3")];
  applied: MailChange[] = [];
  failApply = false;
  failLabels = false;
  labels: Record<string, readonly string[]> = {};

  async preview(_query: MailQuery, limit: number): Promise<readonly EmailMessage[]> {
    return this.messages.slice(0, limit);
  }

  async apply(change: MailChange): Promise<void> {
    if (this.failApply) throw new Error("provider refused");
    this.applied.push(change);
  }

  async labelsOf(ids: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    if (this.failLabels) throw new Error("could not read labels");
    return Object.fromEntries(ids.map((id) => [id, this.labels[id] ?? ["INBOX"]]));
  }
}

async function plan(provider: FakeMail, overrides: Record<string, unknown> = {}) {
  return planChange({
    provider,
    query: { q: "from:newsletter" },
    operation: "archive",
    ...overrides,
  });
}

describe("nothing can be destroyed", () => {
  /**
   * Trash is a label change the user can undo from their own client for thirty
   * days; permanent deletion is a phone call to support. Not omitted for
   * caution — omitted because nothing an assistant does to an inbox is worth
   * making irreversible.
   */
  it("offers no permanent delete", () => {
    expect(mailOperationSchema.safeParse("delete").success).toBe(false);
    expect(mailOperationSchema.safeParse("delete-forever").success).toBe(false);
    expect(mailOperationSchema.safeParse("trash").success).toBe(true);
  });

  it("tells the user that archiving is reversible", async () => {
    const provider = new FakeMail();
    expect(describePlan(await plan(provider))).toContain("Nothing is deleted");
  });
});

describe("bulk is previewed before it happens", () => {
  // "Archive my newsletters?" is not a question a person can answer, because
  // they cannot see what the agent matched.
  it("reports the count and a sample without touching anything", async () => {
    const provider = new FakeMail();
    const result = await plan(provider);

    expect(result.matched).toBe(3);
    expect(result.sample).toContain("Newsletter 1");
    expect(provider.applied).toHaveLength(0);
  });

  // Leading with the sample invites skimming the examples and missing that
  // there are two thousand of them.
  it("leads with the count, not the examples", async () => {
    const provider = new FakeMail();
    const described = describePlan(await plan(provider));
    expect(described.indexOf("3 messages")).toBeLessThan(described.indexOf("Newsletter 1"));
  });

  it("says plainly when nothing matched", async () => {
    const provider = new FakeMail();
    provider.messages = [];
    expect(describePlan(await plan(provider))).toBe("Nothing matches that.");
  });

  // A preview showing bodies would be a way to read the whole inbox through an
  // operation meant to tidy it.
  it("samples subjects only, never bodies", async () => {
    const provider = new FakeMail();
    const result = await plan(provider);
    expect(JSON.stringify(result.sample)).not.toContain("Sale ends Friday");
  });

  it("bounds one operation and says it did", async () => {
    const provider = new FakeMail();
    provider.messages = Array.from({ length: 900 }, (_, i) => message(String(i)));

    const result = await plan(provider);
    expect(result.matched).toBe(MAX_BATCH);
    expect(result.truncated).toBe(true);
    expect(describePlan(result)).toContain("more than I will change at once");
  });
});

describe("bulk is approved above a threshold", () => {
  it("does not ask about a handful", async () => {
    const provider = new FakeMail();
    const result = await plan(provider);

    expect(result.needsApproval).toBe(false);
    expect((await applyChange({ provider, plan: result, approved: false, now: NOW })).ok).toBe(
      true
    );
  });

  // The cost of asking is a tap; the cost of not asking is an inbox someone has
  // to reconstruct by hand.
  it("asks about a lot", async () => {
    const provider = new FakeMail();
    provider.messages = Array.from({ length: BULK_APPROVAL_THRESHOLD + 5 }, (_, i) =>
      message(String(i))
    );

    const result = await plan(provider);
    expect(result.needsApproval).toBe(true);

    const outcome = await applyChange({ provider, plan: result, approved: false, now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("confirm");
    expect(provider.applied).toHaveLength(0);
  });

  it("proceeds once approved", async () => {
    const provider = new FakeMail();
    provider.messages = Array.from({ length: 50 }, (_, i) => message(String(i)));

    const result = await plan(provider);
    expect((await applyChange({ provider, plan: result, approved: true, now: NOW })).ok).toBe(true);
    expect(provider.applied).toHaveLength(1);
  });

  it("refuses a label operation with no label", async () => {
    const provider = new FakeMail();
    const result = await plan(provider, { operation: "add-label" });

    const outcome = await applyChange({ provider, plan: result, approved: true, now: NOW });
    expect(outcome.ok).toBe(false);
    expect(provider.applied).toHaveLength(0);
  });
});

describe("undo is a replay, not a guess", () => {
  /**
   * An undo record written from the post-change state would describe the state
   * it created rather than the one it replaced — worse than having no undo,
   * because it looks like one.
   */
  it("captures the prior labels before applying anything", async () => {
    const provider = new FakeMail();
    provider.labels = { "1": ["INBOX", "IMPORTANT"], "2": ["INBOX"], "3": ["INBOX"] };

    const outcome = await applyChange({
      provider,
      plan: await plan(provider),
      approved: true,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.undo.previousLabels["1"]).toEqual(["INBOX", "IMPORTANT"]);
    }
  });

  // Better to not do it than to do it unrecoverably.
  it("aborts entirely when the prior state cannot be recorded", async () => {
    const provider = new FakeMail();
    provider.failLabels = true;

    const outcome = await applyChange({
      provider,
      plan: await plan(provider),
      approved: true,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("could not record how to undo");
    expect(provider.applied).toHaveLength(0);
  });

  // An inverse is a guess about what the state used to be; the record is what it
  // actually was, including labels the operation never touched.
  it("restores exactly what was there, not the inverse of the operation", async () => {
    const provider = new FakeMail();
    provider.labels = { "1": ["INBOX", "IMPORTANT"], "2": ["INBOX"], "3": ["INBOX"] };

    const applied = await applyChange({
      provider,
      plan: await plan(provider),
      approved: true,
      now: NOW,
    });
    if (!applied.ok) throw new Error("expected success");

    provider.applied = [];
    const undone = await undoChange(provider, applied.undo);

    expect(undone.ok).toBe(true);
    expect(JSON.stringify(provider.applied)).toContain("IMPORTANT");
  });

  it("reports a provider failure rather than throwing", async () => {
    const provider = new FakeMail();
    provider.failApply = true;

    const outcome = await applyChange({
      provider,
      plan: await plan(provider),
      approved: true,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
  });

  it("changes nothing when nothing matched", async () => {
    const provider = new FakeMail();
    provider.messages = [];

    const outcome = await applyChange({
      provider,
      plan: await plan(provider),
      approved: true,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    expect(provider.applied).toHaveLength(0);
  });
});

describe("an inbox is a channel strangers write into", () => {
  /**
   * "Archive all security alerts" is a sensible-sounding sentence and a perfect
   * attack. The refusal comes from the gate, not from this module — which is
   * why it is worth asserting here that the gate actually covers it.
   */
  it("cannot be driven by untrusted content alone", () => {
    expect(
      authorizeTool({ newContext: ["untrusted"], userConfirmed: false }, "delete-data").allowed
    ).toBe(false);
  });
});

describe("rescuing misfiled mail", () => {
  const spam: EmailMessage[] = [
    message("s1", { from: "no-reply@air.example", subject: "Your booking is confirmed" }),
    message("s2", { from: "winner@lottery.example", subject: "You have won" }),
    message("s3", { from: "billing@air.example", subject: "Receipt" }),
  ];

  // A booking confirmation in the spam folder is a task that silently failed.
  it("finds mail from senders the user knows", () => {
    const rescued = likelyMisfiled(spam, ["no-reply@air.example"]);
    expect(rescued.map((message) => message.id)).toContain("s1");
  });

  it("matches other addresses at a known domain", () => {
    const rescued = likelyMisfiled(spam, ["no-reply@air.example"]);
    expect(rescued.map((message) => message.id)).toContain("s3");
  });

  /**
   * Matched on sender, not content. Content matching in a spam folder means
   * reading attacker-authored text to decide what to rescue, which is the wrong
   * direction entirely.
   */
  it("leaves genuine spam where it is", () => {
    expect(likelyMisfiled(spam, ["no-reply@air.example"]).map((m) => m.id)).not.toContain("s2");
  });

  it("rescues nothing when no senders are known", () => {
    expect(likelyMisfiled(spam, [])).toEqual([]);
  });
});
