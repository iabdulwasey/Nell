/**
 * Provenance labelling.
 *
 * Everything that enters an agent turn carries a provenance label. The policy
 * engine uses it to decide whether a turn may invoke consequential tools: a turn
 * whose new context is untrusted-only cannot spend money, send messages, use
 * credentials, or write memory without a fresh user confirmation.
 *
 * This is the structural answer to prompt injection — an attacker-authored email
 * can say anything it likes, but the dispatcher refuses to act on it.
 */

import { z } from "zod";

export const provenanceSchema = z.enum([
  /** Authored by the authenticated owner of the workspace. Fully trusted. */
  "user",
  /** Produced by our own server code (policy decisions, structured outcomes). */
  "system",
  /**
   * Third-party authored: email bodies, web page text, inbound messages from
   * non-owners, tool output derived from any of those. Never authoritative.
   */
  "untrusted",
]);

export type Provenance = z.infer<typeof provenanceSchema>;

/** A piece of context with its origin recorded. */
export interface Provenanced<T> {
  readonly provenance: Provenance;
  readonly value: T;
}

export function trusted<T>(value: T): Provenanced<T> {
  return { provenance: "user", value };
}

export function system<T>(value: T): Provenanced<T> {
  return { provenance: "system", value };
}

export function untrusted<T>(value: T): Provenanced<T> {
  return { provenance: "untrusted", value };
}

/**
 * Taint propagation: combining any untrusted input yields untrusted output.
 * Trust never increases by mixing.
 */
export function combineProvenance(parts: readonly Provenance[]): Provenance {
  if (parts.includes("untrusted")) return "untrusted";
  if (parts.includes("user")) return "user";
  return "system";
}

/** Whether this provenance may, on its own, authorize a consequential action. */
export function mayAuthorizeAction(provenance: Provenance): boolean {
  return provenance !== "untrusted";
}
