import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { isSecret, Secret, secret } from "./secret.js";

describe("Secret", () => {
  const value = secret("super-sensitive", "password");

  // These four are the whole point: plaintext must not escape by accident.
  it("does not leak through string interpolation", () => {
    expect(`${String(value)}`).toBe("[redacted]");
  });

  it("does not leak through JSON.stringify", () => {
    expect(JSON.stringify({ value })).toBe('{"value":"[redacted]"}');
  });

  it("does not leak through util.inspect / console.log", () => {
    expect(inspect(value)).toBe("Secret<password>([redacted])");
    expect(inspect({ nested: value })).not.toContain("super-sensitive");
  });

  it("only reveals the value through the explicit expose() call", () => {
    expect(value.expose()).toBe("super-sensitive");
  });

  it("keeps a non-sensitive label available", () => {
    expect(value.label).toBe("password");
  });

  it("identifies secrets at runtime", () => {
    expect(isSecret(value)).toBe(true);
    expect(isSecret("plain")).toBe(false);
  });

  it("wraps non-string payloads too", () => {
    const structured = new Secret({ token: "abc" }, "oauth");
    expect(JSON.stringify(structured)).toBe('"[redacted]"');
    expect(structured.expose().token).toBe("abc");
  });
});
