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

  it("flags truncation so the worker knows to scroll rather than conclude", () => {
    const snapshot = snapshotOf(
      Array.from({ length: MAX_NODES + 10 }, (_, i) => node({ ref: `e${String(i)}` }))
    );
    expect(snapshot.truncated).toBe(true);
    expect(renderSnapshot(snapshot)).toContain("truncated");
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

describe("choosing how to look", () => {
  const usable = snapshotOf([node({ role: "button", name: "Continue" })]);

  // The default must be the cheap path, or the cost model collapses.
  it("uses the snapshot when the page is drivable", () => {
    expect(choosePerception({ snapshot: usable, failureCount: 0 })).toEqual({
      mode: "snapshot",
    });
  });

  it("escalates when nothing on the page can be acted on", () => {
    const inert = snapshotOf([node({ role: "heading", name: "Loading" })]);
    expect(choosePerception({ snapshot: inert, failureCount: 0 })).toMatchObject({
      mode: "vision",
      reason: "no-interactive-nodes",
    });
  });

  // Evidence, not preference: the structured path must actually have failed.
  it("escalates only after repeated failure", () => {
    expect(
      choosePerception({ snapshot: usable, failureCount: VISION_AFTER_FAILURES - 1 }).mode
    ).toBe("snapshot");
    expect(
      choosePerception({ snapshot: usable, failureCount: VISION_AFTER_FAILURES })
    ).toMatchObject({ mode: "vision", reason: "repeated-failure" });
  });

  it("escalates for genuinely visual work", () => {
    expect(choosePerception({ snapshot: usable, failureCount: 0, visualTask: true }).reason).toBe(
      "visual-task"
    );
  });

  it("escalates for canvas or image content with no structure", () => {
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
        visualTask: true,
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
