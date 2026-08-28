/**
 * Secret<T> — a value that must never be logged, serialized, or sent to a model.
 *
 * The wrapper overrides every implicit stringification path (toString, toJSON,
 * util.inspect) so an accidental `console.log(secret)` or `JSON.stringify({
 * secret })` prints a redaction marker instead of the plaintext. Reading the
 * real value requires the explicit `expose()` call, which is greppable in review.
 */

const REDACTED = "[redacted]";

/** Node's util.inspect hook, referenced without importing `util`. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Secret<T = string> {
  readonly #value: T;
  readonly #label: string;

  constructor(value: T, label = "secret") {
    this.#value = value;
    this.#label = label;
  }

  /**
   * Retrieve the plaintext. Every call site is a deliberate, reviewable
   * decision — never call this to build a model prompt or a log line.
   */
  expose(): T {
    return this.#value;
  }

  /** Human-readable name of what this holds (never the value itself). */
  get label(): string {
    return this.#label;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret<${this.#label}>(${REDACTED})`;
  }
}

export function secret<T>(value: T, label?: string): Secret<T> {
  return new Secret(value, label);
}

export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}
