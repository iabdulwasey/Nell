/**
 * Turning a place into a name, and a name into a place.
 *
 * Two jobs, one service. A shared pin arrives as coordinates and has to become
 * something a search box understands — "Hyderabad, Telangana, India" works
 * where "17.385, 78.487" does not. And a typed answer has to be *checked*: when
 * Nell asks where the user is, the next message might be the answer or might be
 * an unrelated request, and storing "find me pizza" as someone's home city is
 * the kind of memory that quietly ruins every later task.
 *
 * That check is the reason this exists at all rather than trusting the text. A
 * place that geocodes is a place; anything else is a message that happened to
 * arrive next.
 *
 * OpenStreetMap's Nominatim: no key, no account, and its usage policy asks for
 * an identifying User-Agent and a low request rate — both of which a personal
 * assistant answering "where do you live" once satisfies comfortably. A failure
 * is never fatal here: the caller falls back to the raw text or to asking again.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org";

/** Nominatim's policy asks callers to identify themselves. */
const USER_AGENT = "Nell personal assistant (https://github.com/iabdulwasey/Nell)";

export interface GeocodeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Place {
  readonly display_name?: string;
  readonly address?: Record<string, string>;
}

/**
 * A short, human name for a place.
 *
 * Nominatim's `display_name` is exhaustive — house number, suburb, district,
 * postcode, country — and a search box does worse with all of it than with
 * three parts of it. Assembled from the address components instead, coarsest
 * useful first, because "Hyderabad, Telangana, India" is what a person would
 * say and what a cinema listing will match.
 */
function shortName(place: Place): string | undefined {
  const address = place.address;
  if (!address) return place.display_name;

  const city =
    address["city"] ??
    address["town"] ??
    address["village"] ??
    address["municipality"] ??
    address["suburb"] ??
    address["county"];
  const region = address["state"] ?? address["region"];
  const country = address["country"];

  const parts = [city, region, country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : place.display_name;
}

async function ask(url: string, options: GeocodeOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`Geocoder returned ${String(response.status)}.`);
  return response.json();
}

/** Coordinates to a place name. Undefined when the service cannot say. */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  options: GeocodeOptions = {}
): Promise<string | undefined> {
  try {
    const url =
      `${ENDPOINT}/reverse?format=jsonv2&zoom=10&` +
      `lat=${String(latitude)}&lon=${String(longitude)}`;
    const place = (await ask(url, options)) as Place;
    return shortName(place);
  } catch {
    return undefined;
  }
}

/**
 * Is this text a place, and what is it called?
 *
 * The gate on believing an answer. Returns the canonical name so what gets
 * stored is "Hyderabad, Telangana, India" rather than whatever spelling and
 * capitalisation the message happened to use — which matters because this
 * string goes into search queries for years afterwards.
 */
const READS_AS_A_REQUEST =
  /\b(find|get|show|book|check|look|tell|give|search|order|buy|send|what|when|why|how|can|could|would|please|do|does|is|are)\b/iu;

export async function resolvePlace(
  text: string,
  options: GeocodeOptions = {}
): Promise<string | undefined> {
  const query = text.trim();

  /**
   * Length is checked first, and it is doing real work.
   *
   * Nominatim will find *something* for a surprising amount of prose — street
   * names match common words — so a sentence like "find me pizza near me" can
   * come back with a confident result somewhere in the world. A place someone
   * types in answer to "where are you?" is a few words.
   */
  if (query.length === 0 || query.length > 80 || query.split(/\s+/u).length > 8) return undefined;

  /**
   * A request is not an answer.
   *
   * Length alone is not enough — "find me pizza near me" is five words and sails
   * through it. Tested against the live service it happened to return nothing,
   * which is luck rather than a property, and the failure it protects against is
   * silent: a wrong home city is never noticed, it just makes every later task
   * subtly wrong.
   *
   * A place name does not contain "find me" or "can you". Checked before the
   * request, so an obvious non-answer never depends on the geocoder's judgement.
   */
  if (READS_AS_A_REQUEST.test(query)) return undefined;

  try {
    const url = `${ENDPOINT}/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
    const results = (await ask(url, options)) as Place[];
    const first = results[0];
    return first ? shortName(first) : undefined;
  } catch {
    return undefined;
  }
}
