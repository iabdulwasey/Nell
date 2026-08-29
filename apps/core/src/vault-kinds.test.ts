/**
 * The four kinds, and the rule about which ones are tied to a site.
 *
 * The interesting content here is not validation — it is the asymmetry. A login
 * must name a site; an address, a card and a phone must not be forced to. That
 * is a deliberate divergence from both the product this was modelled on (which
 * ties nothing to a site, so a stored password can be typed into a page that
 * merely looks right) and from a simpler rule that ties everything (which would
 * refuse a card at the one moment you need it, in a shop you have not used
 * before).
 */

import { originBound } from "@nell/vault";
import { describe, expect, it } from "vitest";
import { FORMS, formFor } from "./vault-kinds.js";

const of = (kind: string) => FORMS.find((form) => form.kind === kind)!;
const from = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("the sections", () => {
  it("is exactly logins, addresses, cards and phones", () => {
    expect(FORMS.map((form) => form.section)).toEqual(["Logins", "Addresses", "Cards", "Phones"]);
  });

  /** A kind arriving in a URL is a string from outside; it is matched, not trusted. */
  it("falls back to logins for anything it does not recognise", () => {
    expect(formFor("payment").kind).toBe("payment");
    expect(formFor("identity").kind).toBe("login");
    expect(formFor("../../etc/passwd").kind).toBe("login");
    expect(formFor(null).kind).toBe("login");
  });

  /**
   * The asymmetry, stated as a test so a later "tidy-up" that makes all four
   * consistent has to argue with something.
   */
  it("ties a login to a site and leaves the other three unbound", () => {
    expect(originBound("login")).toBe(true);
    for (const kind of ["address", "payment", "phone"] as const) {
      expect(originBound(kind), kind).toBe(false);
    }
  });
});

describe("a login", () => {
  it("needs a site, and refuses to be saved without one", () => {
    const built = of("login").build(from({ username: "ada", password: "hunter2" }), "");
    expect(built.ok).toBe(false);
  });

  it("keeps the site it was given, not one that was typed", () => {
    const built = of("login").build(
      // A site in the form body is ignored when the link already carried one:
      // the caller passes the browser's live origin as the second argument.
      from({ username: "ada", password: "hunter2", origin: "https://evil.example" }),
      "https://shop.example"
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.item.origins).toEqual(["https://shop.example"]);
  });

  it("names itself after the site when nobody names it", () => {
    const built = of("login").build(
      from({ username: "ada", password: "hunter2" }),
      "https://shop.example"
    );
    expect(built.ok && built.item.label).toBe("shop.example");
  });

  it("normalises a second-factor seed rather than storing it as typed", () => {
    const built = of("login").build(
      from({ username: "ada", password: "x", totp: "jbsw y3dp ehpk 3pxp" }),
      "https://shop.example"
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Base32 is upper-case and unspaced; a seed copied off a screen is neither.
    expect(built.item.value["totpSecret"]).toBe("JBSWY3DPEHPK3PXP");
  });
});

describe("an address", () => {
  it("is stored as separate fields, so a multi-box checkout can be filled", () => {
    const built = of("address").build(
      from({
        line1: "12 Rosewood Court",
        city: "Bristol",
        region: "Somerset",
        postalCode: "BS1 4TR",
        country: "gb",
      }),
      ""
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.item.value).toMatchObject({
      line1: "12 Rosewood Court",
      city: "Bristol",
      region: "Somerset",
      postalCode: "BS1 4TR",
      country: "GB",
    });
    // Unbound: an address is filled in wherever it is asked for.
    expect(built.item.origins).toEqual([]);
  });

  it("wants the two-letter country code, not the country's name", () => {
    const built = of("address").build(
      from({ line1: "12 Rosewood Court", city: "Bristol", postalCode: "BS1", country: "England" }),
      ""
    );
    expect(built.ok).toBe(false);
  });
});

describe("a card", () => {
  /**
   * The rule, not a missing feature: PCI DSS forbids keeping a security code
   * after authorisation. The happy consequence is that a number lifted from a
   * page is largely unusable, which is most of why a card can be unscoped.
   */
  it("has nowhere to put a security code", () => {
    expect(of("payment").fields.map((field) => field.name)).not.toContain("cvc");

    const built = of("payment").build(
      from({
        cardholderName: "A Wasey",
        number: "4111111111111111",
        expiryMonth: "9",
        expiryYear: "2029",
        billingPostalCode: "BS1 4TR",
        // Offered anyway, the way a hostile or careless caller would.
        cvc: "737",
      }),
      ""
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(JSON.stringify(built.item.value)).not.toContain("737");
  });

  it("shows only the last four in the listing", () => {
    const built = of("payment").build(
      from({
        cardholderName: "A Wasey",
        number: "4111 1111 1111 1111",
        expiryMonth: "9",
        expiryYear: "2029",
        billingPostalCode: "BS1",
      }),
      ""
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.item.accountHint).toBe("ending 1111");
    // Enough to tell two cards apart, useless to anyone who reads it.
    expect(built.item.accountHint).not.toContain("4111");
  });

  it("refuses a number that is not one, and a month that is not one", () => {
    const base = {
      cardholderName: "A Wasey",
      expiryMonth: "9",
      expiryYear: "2029",
      billingPostalCode: "BS1",
    };
    expect(of("payment").build(from({ ...base, number: "41111" }), "").ok).toBe(false);
    expect(
      of("payment").build(from({ ...base, number: "4111111111111111", expiryMonth: "13" }), "").ok
    ).toBe(false);
  });
});

describe("a phone number", () => {
  it("insists on a country code, because a form that wants one gets one", () => {
    expect(of("phone").build(from({ e164: "07700 900123" }), "").ok).toBe(false);

    const built = of("phone").build(from({ e164: "+44 7700 900123" }), "");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.item.value["e164"]).toBe("+447700900123");
  });
});
