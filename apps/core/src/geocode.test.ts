import { describe, expect, it } from "vitest";
import { resolvePlace, reverseGeocode } from "./geocode.js";
import { needsLocation } from "./profile.js";

const HYDERABAD = {
  display_name: "Hyderabad, Hyderabad District, Telangana, 500001, India",
  address: { city: "Hyderabad", state: "Telangana", country: "India", postcode: "500001" },
};

function respond(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("naming a place", () => {
  /**
   * `display_name` carries house number, suburb, district and postcode. A search
   * box does worse with all of it than with three parts of it.
   */
  it("shortens a pin to something a search box understands", async () => {
    expect(await reverseGeocode(17.385, 78.4867, { fetchImpl: respond(HYDERABAD) })).toBe(
      "Hyderabad, Telangana, India"
    );
  });

  it("falls back to the full name when there are no components", async () => {
    expect(await reverseGeocode(1, 2, { fetchImpl: respond({ display_name: "Somewhere" }) })).toBe(
      "Somewhere"
    );
  });

  /** A geocoder being down must not become a wrong fact about the user. */
  it("says nothing rather than guessing when the service fails", async () => {
    expect(await reverseGeocode(1, 2, { fetchImpl: respond({}, 503) })).toBeUndefined();
    expect(await resolvePlace("Hyderabad", { fetchImpl: respond({}, 503) })).toBeUndefined();
  });
});

describe("deciding whether an answer is a place", () => {
  it("canonicalises what the user typed", async () => {
    // Stored for years and used in every later search, so the spelling that
    // gets kept should not be whichever one was typed at the time.
    expect(await resolvePlace("bangalore", { fetchImpl: respond([HYDERABAD]) })).toBe(
      "Hyderabad, Telangana, India"
    );
  });

  /**
   * The rule that matters. Someone who ignores "where are you?" and asks for
   * something else must not end up with "find me pizza" recorded as where they
   * live — a wrong fact here quietly spoils every later task, and unlike a wrong
   * action nobody watches it happen.
   *
   * Length and word count are checked before the request is made, because
   * Nominatim will confidently match prose against street names somewhere in the
   * world. Asserted by proving the geocoder is never even asked.
   */
  it("refuses prose without asking the geocoder", async () => {
    let asked = false;
    const watching: typeof fetch = async () => {
      asked = true;
      return new Response(JSON.stringify([HYDERABAD]), { status: 200 });
    };

    for (const text of [
      "find me pizza near me",
      "Check google and find me spiderman show near me post 9 pm",
      "can you look up the weather and tell me if I need a coat today",
      "show me the news",
      "what time is it",
    ]) {
      expect(await resolvePlace(text, { fetchImpl: watching }), text).toBeUndefined();
    }

    expect(asked, "the geocoder should never have been consulted").toBe(false);
  });

  /** And the filter must not reject the answers it exists to let through. */
  it("still accepts ordinary place names", async () => {
    for (const text of ["Hyderabad", "New Delhi", "San Francisco, CA", "Bengaluru, Karnataka"]) {
      expect(await resolvePlace(text, { fetchImpl: respond([HYDERABAD]) }), text).toBe(
        "Hyderabad, Telangana, India"
      );
    }
  });

  it("says nothing for an empty answer, and for no match", async () => {
    expect(await resolvePlace("   ", { fetchImpl: respond([]) })).toBeUndefined();
    expect(await resolvePlace("Xyzzyville", { fetchImpl: respond([]) })).toBeUndefined();
  });
});

describe("knowing when location is needed", () => {
  it("spots the phrasings that have no answer without it", () => {
    for (const text of [
      "find me best shows for spiderman near me at or post 9 pm",
      "what is the nearest pharmacy",
      "any good restaurants nearby",
      "cinemas in my area",
      "what's the weather where I am",
    ]) {
      expect(needsLocation(text), text).toBe(true);
    }
  });

  it("leaves tasks that do not need it alone", () => {
    for (const text of [
      "give me the latest AI and tech news",
      "book a flight to Delhi on Friday",
      "what time does the shop close",
    ]) {
      expect(needsLocation(text), text).toBe(false);
    }
  });
});
