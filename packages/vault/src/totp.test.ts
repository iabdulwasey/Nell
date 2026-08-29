import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  parseOtpauthUri,
  secondsRemaining,
  totpAt,
  TOTP_PERIOD_SECONDS,
  verifyTotp,
} from "./index.js";

/**
 * RFC 6238 Appendix B. The seed is the ASCII string "12345678901234567890",
 * base32-encoded, and these are the published expected values.
 *
 * Checking against the RFC rather than against our own output is the point: an
 * implementation verified only against itself is a coin flip, and the failure
 * mode is "login works sometimes", which nobody debugs correctly.
 */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_SECRET_SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";

describe("RFC 6238 test vectors", () => {
  it("matches the published SHA-1 values", () => {
    const cases: readonly (readonly [number, string])[] = [
      [59, "94287082"],
      [1_111_111_109, "07081804"],
      [1_111_111_111, "14050471"],
      [1_234_567_890, "89005924"],
      [2_000_000_000, "69279037"],
      [20_000_000_000, "65353130"],
    ];

    for (const [seconds, expected] of cases) {
      expect(totpAt({ secret: RFC_SECRET, digits: 8 }, seconds * 1000)).toBe(expected);
    }
  });

  it("matches the published SHA-256 values", () => {
    expect(totpAt({ secret: RFC_SECRET_SHA256, digits: 8, algorithm: "SHA256" }, 59_000)).toBe(
      "46119246"
    );
  });
});

describe("generating a code", () => {
  it("produces six digits by default", () => {
    expect(totpAt({ secret: RFC_SECRET }, 59_000)).toMatch(/^\d{6}$/u);
  });

  it("pads a short code rather than dropping a leading zero", () => {
    // A code rendered as five digits is rejected by every site that asked for
    // six, and looks like a wrong password rather than a formatting bug.
    for (let step = 0; step < 400; step += 1) {
      expect(totpAt({ secret: RFC_SECRET }, step * 30_000)).toHaveLength(6);
    }
  });

  it("changes every period and is stable within one", () => {
    const base = 1_700_000_000_000;
    const inSameStep = base - (base % (TOTP_PERIOD_SECONDS * 1000));

    expect(totpAt({ secret: RFC_SECRET }, inSameStep)).toBe(
      totpAt({ secret: RFC_SECRET }, inSameStep + 29_000)
    );
    expect(totpAt({ secret: RFC_SECRET }, inSameStep)).not.toBe(
      totpAt({ secret: RFC_SECRET }, inSameStep + 30_000)
    );
  });

  it("says how long the code has left, so a user can be told to hurry", () => {
    const base = 1_700_000_000_000;
    const aligned = base - (base % 30_000);
    expect(secondsRemaining({ secret: RFC_SECRET }, aligned)).toBe(30);
    expect(secondsRemaining({ secret: RFC_SECRET }, aligned + 25_000)).toBe(5);
  });
});

describe("verifying a code", () => {
  const at = 1_700_000_000_000;

  it("accepts the current code", () => {
    expect(verifyTotp({ secret: RFC_SECRET }, totpAt({ secret: RFC_SECRET }, at), at)).toBe(true);
  });

  // A phone's clock and a server's clock disagree often enough that zero
  // tolerance means real users failing to log in.
  it("tolerates one step of clock drift either way", () => {
    for (const offset of [-30_000, 30_000]) {
      const code = totpAt({ secret: RFC_SECRET }, at + offset);
      expect(verifyTotp({ secret: RFC_SECRET }, code, at)).toBe(true);
    }
  });

  it("refuses a code from further away than that", () => {
    const stale = totpAt({ secret: RFC_SECRET }, at - 120_000);
    expect(verifyTotp({ secret: RFC_SECRET }, stale, at)).toBe(false);
  });

  it("refuses a wrong code", () => {
    expect(verifyTotp({ secret: RFC_SECRET }, "000000", at)).toBe(false);
    expect(verifyTotp({ secret: RFC_SECRET }, "", at)).toBe(false);
    expect(verifyTotp({ secret: RFC_SECRET }, "not-a-code", at)).toBe(false);
  });
});

describe("base32", () => {
  it("decodes what a QR code actually contains", () => {
    expect(decodeBase32(RFC_SECRET).toString("utf8")).toBe("12345678901234567890");
  });

  it("tolerates the spacing and padding sites print", () => {
    expect(decodeBase32("GEZD GNBV GY3T-QOJQ").length).toBeGreaterThan(0);
    expect(decodeBase32("MZXW6===").toString("utf8")).toBe("foo");
  });

  it("refuses characters that are not base32", () => {
    expect(() => decodeBase32("not-valid-base32!")).toThrow(/base32/iu);
  });
});

describe("otpauth:// URIs", () => {
  // Asking someone to pick the seed out of a URL by hand is how a seed ends up
  // mistyped and a login mysteriously stops working two weeks later.
  it("parses what a user pastes from a setup page", () => {
    const config = parseOtpauthUri(
      `otpauth://totp/Example:ada@example.com?secret=${RFC_SECRET}&issuer=Example&digits=6&period=30`
    );
    expect(config?.secret).toBe(RFC_SECRET);
    expect(config?.digits).toBe(6);
  });

  it("reads a non-default algorithm and digit count", () => {
    const config = parseOtpauthUri(
      `otpauth://totp/E?secret=${RFC_SECRET}&algorithm=SHA256&digits=8&period=60`
    );
    expect(config).toMatchObject({ algorithm: "SHA256", digits: 8, periodSeconds: 60 });
  });

  // HOTP is counter-based and a different thing entirely; accepting one would
  // produce codes that are always wrong.
  it("refuses a counter-based URI", () => {
    expect(parseOtpauthUri(`otpauth://hotp/E?secret=${RFC_SECRET}&counter=1`)).toBeUndefined();
  });

  it("refuses a URI with no secret, a bad secret, or the wrong scheme", () => {
    expect(parseOtpauthUri("otpauth://totp/E?issuer=Example")).toBeUndefined();
    expect(parseOtpauthUri("otpauth://totp/E?secret=!!!not-base32!!!")).toBeUndefined();
    expect(parseOtpauthUri(`https://example.com/?secret=${RFC_SECRET}`)).toBeUndefined();
    expect(parseOtpauthUri("nonsense")).toBeUndefined();
  });

  it("refuses out-of-range parameters rather than producing wrong codes", () => {
    expect(parseOtpauthUri(`otpauth://totp/E?secret=${RFC_SECRET}&digits=12`)).toBeUndefined();
    expect(parseOtpauthUri(`otpauth://totp/E?secret=${RFC_SECRET}&period=0`)).toBeUndefined();
    expect(parseOtpauthUri(`otpauth://totp/E?secret=${RFC_SECRET}&algorithm=MD5`)).toBeUndefined();
  });
});
