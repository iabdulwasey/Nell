import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  choosePerception,
  estimateTokens,
  isInteractive,
  isWorthShowing,
  MAX_NODES,
  renderSnapshot,
  SCREENSHOT_TOKENS,
  VISION_AFTER_FAILURES,
  type SnapshotNode,
} from "./index.js";

function node(overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return { ref: "e1", role: "button", name: "Continue", ...overrides };
}

function snapshotOf(nodes: readonly SnapshotNode[], text?: string) {
  return buildSnapshot({
    url: "https://example.com/checkout",
    title: "Checkout",
    candidates: nodes,
    text,
  });
}

describe("what a model is shown", () => {
  it("keeps the interaction surface", () => {
    for (const role of ["button", "link", "textbox", "checkbox", "combobox"]) {
      expect(isWorthShowing(role)).toBe(true);
      expect(isInteractive(role)).toBe(true);
    }
  });

  it("keeps informative roles but does not treat them as actionable", () => {
    expect(isWorthShowing("heading")).toBe(true);
    expect(isInteractive("heading")).toBe(false);
  });

  // Layout markup is noise that invites reasoning about implementation.
  it("drops layout noise", () => {
    for (const role of ["generic", "presentation", "none", "div"]) {
      expect(isWorthShowing(role)).toBe(false);
    }
  });

  it("filters candidates down to what matters", () => {
    const snapshot = snapshotOf([
      node({ ref: "e1", role: "button" }),
      node({ ref: "e2", role: "generic", name: "wrapper" }),
      node({ ref: "e3", role: "heading", name: "Checkout" }),
    ]);
    expect(snapshot.nodes.map((n) => n.ref)).toEqual(["e1", "e3"]);
  });

  // On a huge page, being able to act matters more than being able to read.
  it("prefers actionable nodes when truncating", () => {
    const many = [
      ...Array.from({ length: MAX_NODES }, (_, i) =>
        node({ ref: `h${String(i)}`, role: "heading", name: `H${String(i)}` })
      ),
      node({ ref: "buy", role: "button", name: "Buy now" }),
    ];
    const snapshot = snapshotOf(many);
    expect(snapshot.nodes.some((n) => n.ref === "buy")).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });

  /**
   * This test used to be called "flags truncation so the worker knows to
   * scroll", and it asserted the word "truncated" appeared. Both were wrong in
   * the same way, and the error cost three real tasks: scrolling cannot reveal
   * more, because every element on the page is collected regardless of where the
   * viewport is. The limit is a count, not a window.
   *
   * So what is asserted now is that the note tells the truth — how much is
   * missing — and does not suggest the one action that provably cannot help. A
   * hint that invites an impossible move is worse than no hint, because the
   * model takes it, sees no change, and takes it again until it is declared
   * stuck.
   */
  it("says how much of the page is missing, and does not suggest scrolling", () => {
    const snapshot = snapshotOf(
      Array.from({ length: MAX_NODES + 10 }, (_, i) => node({ ref: `e${String(i)}` }))
    );
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.totalNodes).toBe(MAX_NODES + 10);

    const rendered = renderSnapshot(snapshot);
    expect(rendered).toContain(String(MAX_NODES));
    expect(rendered).toContain(String(MAX_NODES + 10));
    expect(rendered).toContain("whole page");
    expect(rendered).toContain("will not reveal more");

    // The old note said "scroll or narrow the view". Nothing may tell the model
    // to scroll in order to see what is already listed.
    expect(rendered).not.toContain("scroll or narrow");
    expect(rendered).not.toContain("scroll to see");
  });

  it("does not flag truncation on a small page", () => {
    expect(snapshotOf([node()]).truncated).toBe(false);
  });
});

describe("rendering", () => {
  it("gives each node a stable reference the worker can act on", () => {
    const rendered = renderSnapshot(snapshotOf([node({ ref: "e7", name: "Pay now" })]));
    expect(rendered).toContain('[e7] button "Pay now"');
  });

  it("shows state that changes what to do next", () => {
    const rendered = renderSnapshot(
      snapshotOf([
        node({ ref: "e1", role: "button", name: "Pay", disabled: true }),
        node({ ref: "e2", role: "checkbox", name: "Terms", checked: false }),
      ])
    );
    expect(rendered).toContain("(disabled)");
    expect(rendered).toContain("(unchecked)");
  });

  it("includes the page identity", () => {
    expect(renderSnapshot(snapshotOf([node()]))).toContain("https://example.com/checkout");
  });
});

describe("choosing which sense to lead with", () => {
  const usable = snapshotOf([node({ role: "button", name: "Continue" })]);

  // The gate is gone: an earlier design made vision unreachable until the
  // structured path had visibly failed twice.
  it("never withholds a sense — the other is always available", () => {
    for (const input of [
      { snapshot: usable, failureCount: 0 },
      { snapshot: usable, failureCount: 0, visualTask: true },
      { failureCount: 0 },
    ]) {
      const decision = choosePerception(input);
      expect(decision.alsoAvailable).not.toBe(decision.mode);
    }
  });

  it("leads with pixels when there is no snapshot at all", () => {
    expect(choosePerception({ failureCount: 0 }).mode).toBe("vision");
  });

  it("leads with pixels when nothing on the page can be acted on", () => {
    const inert = snapshotOf([node({ role: "heading", name: "Loading" })]);
    expect(choosePerception({ snapshot: inert, failureCount: 0 })).toMatchObject({
      mode: "vision",
      reason: "no-interactive-nodes",
    });
  });

  // Refs are faster and fail loudly, so a clean page is the case for them.
  it("leads with refs on a cleanly drivable page", () => {
    expect(choosePerception({ snapshot: usable, failureCount: 0 })).toMatchObject({
      mode: "snapshot",
      reason: "cleanly-drivable",
    });
  });

  // A lost race is a lost task however good the reasoning was.
  it("leads with refs when the task is racing something", () => {
    expect(choosePerception({ snapshot: usable, failureCount: 0, timeCritical: true }).reason).toBe(
      "time-critical"
    );
  });

  it("does not claim a truncated page is cleanly drivable", () => {
    const partial = snapshotOf(
      Array.from({ length: MAX_NODES + 5 }, (_, i) => node({ ref: `e${String(i)}` }))
    );
    expect(choosePerception({ snapshot: partial, failureCount: 0 }).mode).toBe("vision");
  });

  it("switches to pixels once the structured path has failed repeatedly", () => {
    expect(
      choosePerception({ snapshot: usable, failureCount: VISION_AFTER_FAILURES })
    ).toMatchObject({ mode: "vision", reason: "repeated-failure" });
  });

  it("leads with pixels for genuinely visual work", () => {
    expect(choosePerception({ snapshot: usable, failureCount: 0, visualTask: true }).reason).toBe(
      "visual-task"
    );
  });

  it("leads with pixels for canvas or image content with no structure", () => {
    expect(
      choosePerception({ snapshot: usable, failureCount: 0, opaqueContent: true }).reason
    ).toBe("canvas-or-image");
  });

  it("honours an explicit request over every other signal", () => {
    expect(
      choosePerception({
        snapshot: usable,
        failureCount: 0,
        explicitRequest: true,
        timeCritical: true,
      }).reason
    ).toBe("explicit-request");
  });
});

describe("cost", () => {
  // The whole reason the default is structured: a screenshot costs far more per
  // look, and a task takes many looks.
  it("makes a snapshot dramatically cheaper than a screenshot", () => {
    const snapshot = snapshotOf(
      Array.from({ length: 20 }, (_, i) =>
        node({ ref: `e${String(i)}`, name: `Item ${String(i)}` })
      )
    );
    const structured = estimateTokens("snapshot", snapshot);
    const vision = estimateTokens("vision", snapshot);
    expect(structured).toBeLessThan(vision / 2);
  });

  it("prices vision at its image cost regardless of page size", () => {
    expect(estimateTokens("vision", snapshotOf([node()]))).toBe(SCREENSHOT_TOKENS);
  });

  it("scales snapshot cost with what is actually rendered", () => {
    const small = estimateTokens("snapshot", snapshotOf([node()]));
    const large = estimateTokens(
      "snapshot",
      snapshotOf(Array.from({ length: 50 }, (_, i) => node({ ref: `e${String(i)}` })))
    );
    expect(large).toBeGreaterThan(small);
  });
});
