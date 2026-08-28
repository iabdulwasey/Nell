import { describe, expect, it } from "vitest";
import { operationClassOf, parseActionBatch, validateTarget } from "./index.js";

describe("browser action DSL", () => {
  it("accepts a normal batch", () => {
    const actions = parseActionBatch([
      { action: "goto", url: "https://example.com" },
      { action: "click", target: { by: "role", role: "button", name: "Book" } },
      { action: "type", target: { by: "label", text: "Name" }, text: "Ada" },
    ]);
    expect(actions).toHaveLength(3);
  });

  // There is no "evaluate"/"script"/"code" action, and adding one would be a
  // security regression, so assert the vocabulary stays closed.
  it("has no code-execution action", () => {
    for (const action of ["evaluate", "script", "exec", "code", "eval"]) {
      expect(() => parseActionBatch([{ action, code: "fetch('/')" }])).toThrow();
    }
  });

  it("rejects an unbounded batch", () => {
    const huge = Array.from({ length: 21 }, () => ({ action: "back" }));
    expect(() => parseActionBatch(huge)).toThrow();
    expect(() => parseActionBatch([])).toThrow();
  });

  it("rejects a non-URL navigation", () => {
    expect(() => parseActionBatch([{ action: "goto", url: "javascript:alert(1)" }])).toThrow();
  });

  it("refuses selectors that look like script injection", () => {
    expect(() => {
      validateTarget({ by: "css", selector: "a[href^='javascript:']" });
    }).toThrow(/script injection/iu);
    expect(() => {
      validateTarget({ by: "css", selector: "<script>x</script>" });
    }).toThrow();
    expect(() => {
      validateTarget({ by: "css", selector: "#login-form input[name='user']" });
    }).not.toThrow();
  });

  it("bounds selector and text lengths", () => {
    expect(() =>
      parseActionBatch([{ action: "click", target: { by: "css", selector: "x".repeat(501) } }])
    ).toThrow();
    expect(() =>
      parseActionBatch([
        { action: "type", target: { by: "label", text: "n" }, text: "x".repeat(2001) },
      ])
    ).toThrow();
  });

  it("maps every action onto a taint operation class", () => {
    expect(operationClassOf({ action: "back" })).toBe("navigate");
    expect(operationClassOf({ action: "extract", fields: ["price"] })).toBe("read-text");
    expect(operationClassOf({ action: "screenshot", fullPage: false })).toBe("screenshot");
    expect(
      operationClassOf({
        action: "click",
        target: { by: "text", text: "Buy" },
      })
    ).toBe("click");
  });

  it("applies defaults so callers cannot omit safety-relevant fields", () => {
    const [wait] = parseActionBatch([{ action: "waitFor", target: { by: "text", text: "Done" } }]);
    expect(wait).toMatchObject({ state: "visible", timeoutMs: 5000 });
  });

  it("caps waitFor timeouts", () => {
    expect(() =>
      parseActionBatch([
        {
          action: "waitFor",
          target: { by: "text", text: "x" },
          timeoutMs: 60_000,
        },
      ])
    ).toThrow();
  });
});
