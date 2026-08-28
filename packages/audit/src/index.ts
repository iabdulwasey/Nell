/**
 * @nell/audit
 *
 * Append-only, hash-chained audit log of every consequential action: secret
 * decrypts, vault fills, approvals minted and spent, purchases, outbound
 * messages, memory deletions, monitor fires, key operations.
 *
 * Each entry commits to the previous entry's digest, so removing or editing a
 * historical entry invalidates every entry after it — tampering is detectable
 * without trusting the database. The log is surfaced read-only to the user:
 * auditability is a product feature here, not just a compliance checkbox.
 *
 * Governed by: docs/security-model.md
 */

import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const auditActionSchema = z.enum([
  "secret.decrypt",
  "secret.write",
  "secret.delete",
  "vault.fill",
  "approval.mint",
  "approval.spend",
  "purchase.execute",
  "message.outbound",
  "memory.write",
  "memory.delete",
  "monitor.fire",
  "integration.connect",
  "integration.disconnect",
  "key.rotate",
  "policy.deny",
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEntrySchema = z.object({
  /** Monotonic position in this workspace's chain, starting at 1. */
  sequence: z.number().int().positive(),
  workspaceId: z.string().min(1),
  action: auditActionSchema,
  /** What was acted on: a vault item id, merchant, monitor id, etc. */
  subject: z.string().max(400),
  /** Non-sensitive structured context. Never secrets. */
  detail: z.record(z.string(), z.unknown()).default({}),
  /** RFC 3339 timestamp, supplied by the caller so it is testable. */
  at: z.iso.datetime(),
  /** Digest of the previous entry ("" for the first entry in a chain). */
  previousDigest: z.string(),
  /** Digest committing to this entry and the previous one. */
  digest: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** Fields the caller provides; the chain computes the rest. */
export interface AuditInput {
  readonly workspaceId: string;
  readonly action: AuditAction;
  readonly subject: string;
  readonly detail?: Record<string, unknown>;
  readonly at: string;
}

/**
 * Canonical serialization. Object keys are emitted in sorted order so the digest
 * is stable regardless of property insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Digest for one entry, committing to its content and the previous digest. */
export function computeDigest(
  input: AuditInput & { sequence: number; previousDigest: string }
): string {
  return createHash("sha256")
    .update(
      canonicalize({
        action: input.action,
        at: input.at,
        detail: input.detail ?? {},
        previousDigest: input.previousDigest,
        sequence: input.sequence,
        subject: input.subject,
        workspaceId: input.workspaceId,
      })
    )
    .digest("hex");
}

/**
 * Append an entry to a chain, given the last entry (or undefined to start one).
 * Pure: persistence is the caller's job, which keeps this trivially testable and
 * usable inside a durable workflow step.
 */
export function appendEntry(previous: AuditEntry | undefined, input: AuditInput): AuditEntry {
  if (previous && previous.workspaceId !== input.workspaceId) {
    throw new Error("Audit chains are per-workspace and cannot be interleaved.");
  }

  const sequence = (previous?.sequence ?? 0) + 1;
  const previousDigest = previous?.digest ?? "";
  const digest = computeDigest({ ...input, sequence, previousDigest });

  return auditEntrySchema.parse({
    action: input.action,
    at: input.at,
    detail: input.detail ?? {},
    digest,
    previousDigest,
    sequence,
    subject: input.subject,
    workspaceId: input.workspaceId,
  });
}

export interface VerificationResult {
  readonly valid: boolean;
  /** Sequence number of the first entry that failed, when invalid. */
  readonly brokenAt?: number;
  readonly reason?: string;
}

/**
 * Verify a chain end to end. Detects edited entries, removed entries, and
 * reordering.
 */
export function verifyChain(entries: readonly AuditEntry[]): VerificationResult {
  let previous: AuditEntry | undefined;

  for (const entry of entries) {
    if (entry.sequence !== (previous?.sequence ?? 0) + 1) {
      return {
        valid: false,
        brokenAt: entry.sequence,
        reason: "Sequence is not contiguous; an entry was removed or reordered.",
      };
    }
    if (entry.previousDigest !== (previous?.digest ?? "")) {
      return {
        valid: false,
        brokenAt: entry.sequence,
        reason: "Entry does not commit to the previous entry.",
      };
    }
    const expected = computeDigest({
      action: entry.action,
      at: entry.at,
      detail: entry.detail,
      previousDigest: entry.previousDigest,
      sequence: entry.sequence,
      subject: entry.subject,
      workspaceId: entry.workspaceId,
    });
    if (expected !== entry.digest) {
      return {
        valid: false,
        brokenAt: entry.sequence,
        reason: "Entry content does not match its digest.",
      };
    }
    previous = entry;
  }

  return { valid: true };
}

/**
 * Pseudonymize a subject reference for erasure requests. The chain stays
 * verifiable (the digest still commits to this stable value) while the
 * underlying identifier becomes unrecoverable.
 */
export function pseudonymize(subject: string, erasureKey: string): string {
  return `erased:${createHmac("sha256", erasureKey).update(subject).digest("hex").slice(0, 32)}`;
}
