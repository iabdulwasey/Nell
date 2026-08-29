/**
 * Pairing a desktop companion.
 *
 * The companion is a small app on the user's own machine that lets Nell drive
 * *their* browser — their IP, their cookies, their device history, their
 * presence. It is the honest answer to CAPTCHAs and residential-IP checks,
 * because it is not an evasion of them: the request really does come from the
 * person's computer, because it is their computer.
 *
 * It is also, by a wide margin, the most dangerous thing in this product. A
 * remote-control channel into someone's personal machine is worth more to an
 * attacker than every credential in the vault combined, and the whole design
 * follows from taking that seriously.
 *
 * **The trust direction is inverted here, and that is the key idea.** Everywhere
 * else, Nell's server owns the machine and enforces policy centrally. On a
 * user's own laptop we are the outside party — so the companion does not take
 * instructions, it evaluates requests. It holds its own allowlist, applies its
 * own limits, and refuses on its own authority. If our server were fully
 * compromised tomorrow, the worst it could do to a paired machine is what that
 * machine had already agreed to, which is the property that makes shipping this
 * defensible at all.
 *
 * Pairing itself is mutual and short-lived: both ends display the same code and
 * a person confirms it on both, which is what stops a stranger who guessed a
 * pairing request from being paired to.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Six digits, shown on both screens.
 *
 * Short because a person has to read it off one screen and recognise it on
 * another, and a long code gets copy-pasted, which defeats the point of the
 * human being in the loop.
 */
export const PAIRING_CODE_DIGITS = 6;

/** Two minutes. Long enough to look at two screens, short enough to be useless later. */
export const PAIRING_TTL_MS = 2 * 60 * 1000;

/** Attempts before a pairing attempt is burned. Six digits is a million guesses. */
export const MAX_PAIRING_ATTEMPTS = 3;

export interface PairingRequest {
  readonly id: string;
  readonly workspaceId: string;
  /** Name the user gave the machine, for the revocation list to be legible. */
  readonly deviceLabel: string;
  /** Peppered hash of the code. The code itself is never stored. */
  readonly codeHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  /**
   * Both sides must confirm. A request confirmed only by the server is a
   * stranger who guessed; one confirmed only by the device is a device nobody
   * asked for.
   */
  readonly confirmedByDevice: boolean;
  readonly confirmedByUser: boolean;
}

export function hashCode(code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(code).digest("hex");
}

export interface BeginPairingOptions {
  readonly workspaceId: string;
  readonly deviceLabel: string;
  readonly pepper: string;
  readonly now: number;
  readonly id?: string;
}

export interface BegunPairing {
  readonly request: PairingRequest;
  /** Shown on both screens, then forgotten. */
  readonly code: string;
}

export function beginPairing(options: BeginPairingOptions): BegunPairing {
  // randomInt is drawn from the same CSPRNG as the rest of this file. A code a
  // person will type is still a secret.
  const code = String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");

  return {
    code,
    request: {
      id: options.id ?? randomBytes(8).toString("hex"),
      workspaceId: options.workspaceId,
      deviceLabel: options.deviceLabel.slice(0, 60),
      codeHash: hashCode(code, options.pepper),
      createdAt: options.now,
      expiresAt: options.now + PAIRING_TTL_MS,
      attempts: 0,
      confirmedByDevice: false,
      confirmedByUser: false,
    },
  };
}

export type PairingFailure =
  | "wrong-code"
  | "expired"
  | "too-many-attempts"
  | "already-paired"
  | "not-confirmed-both-sides";

export type PairingResult =
  | { readonly ok: true; readonly request: PairingRequest }
  | { readonly ok: false; readonly reason: PairingFailure; readonly request: PairingRequest };

export interface ConfirmOptions {
  readonly code: string;
  readonly side: "device" | "user";
  readonly pepper: string;
  readonly now: number;
}

/**
 * Confirm one side of a pairing.
 *
 * Returns the updated request either way, including on failure, because the
 * attempt counter has to survive a wrong guess — a counter that resets on
 * failure counts nothing.
 */
export function confirmPairing(request: PairingRequest, options: ConfirmOptions): PairingResult {
  if (request.confirmedByDevice && request.confirmedByUser) {
    return { ok: false, reason: "already-paired", request };
  }
  if (options.now >= request.expiresAt) {
    return { ok: false, reason: "expired", request };
  }
  if (request.attempts >= MAX_PAIRING_ATTEMPTS) {
    return { ok: false, reason: "too-many-attempts", request };
  }

  const presented = hashCode(options.code, options.pepper);
  if (!constantTimeEquals(presented, request.codeHash)) {
    return {
      ok: false,
      reason: "wrong-code",
      request: { ...request, attempts: request.attempts + 1 },
    };
  }

  const updated: PairingRequest = {
    ...request,
    confirmedByDevice: request.confirmedByDevice || options.side === "device",
    confirmedByUser: request.confirmedByUser || options.side === "user",
  };

  if (!updated.confirmedByDevice || !updated.confirmedByUser) {
    return { ok: false, reason: "not-confirmed-both-sides", request: updated };
  }

  return { ok: true, request: updated };
}

/* -------------------------------------------------------------------------- */
/* The paired device                                                           */
/* -------------------------------------------------------------------------- */

export interface PairedDevice {
  readonly id: string;
  readonly workspaceId: string;
  readonly deviceLabel: string;
  /** Peppered hash of the long-lived device token. */
  readonly tokenHash: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt?: number;
  /**
   * Origins this device has agreed to be driven on. Held on the device, not the
   * server — see the module header on why the trust direction is inverted.
   */
  readonly allowedOrigins: readonly string[];
}

export interface CompletePairingOptions {
  readonly request: PairingRequest;
  readonly pepper: string;
  readonly now: number;
  /** What the user chose to allow at pairing time. Empty means nothing yet. */
  readonly allowedOrigins?: readonly string[];
}

export interface CompletedPairing {
  readonly device: PairedDevice;
  /** Returned once, stored by the companion, never recoverable from the record. */
  readonly token: string;
}

export function completePairing(options: CompletePairingOptions): CompletedPairing {
  const token = randomBytes(32).toString("base64url");

  return {
    token,
    device: {
      id: options.request.id,
      workspaceId: options.request.workspaceId,
      deviceLabel: options.request.deviceLabel,
      tokenHash: hashCode(token, options.pepper),
      pairedAt: options.now,
      lastSeenAt: options.now,
      // Nothing by default. A device that agreed to be paired has not thereby
      // agreed to be driven anywhere in particular.
      allowedOrigins: options.allowedOrigins ?? [],
    },
  };
}

/**
 * Revoke a device.
 *
 * Instant and one-directional. Someone reaching for this is worried, and a
 * revocation that takes effect at the next heartbeat is not a revocation.
 */
export function revokeDevice(device: PairedDevice, now: number): PairedDevice {
  return device.revokedAt === undefined ? { ...device, revokedAt: now } : device;
}

export function isUsable(device: PairedDevice): boolean {
  return device.revokedAt === undefined;
}

export function explainPairingFailure(reason: PairingFailure): string {
  switch (reason) {
    case "wrong-code":
      return "That code does not match. Check the one shown on your computer.";
    case "expired":
      return "That pairing code has expired — start again and I will show a new one.";
    case "too-many-attempts":
      return "Too many wrong codes. Start the pairing again.";
    case "already-paired":
      return "That device is already paired.";
    case "not-confirmed-both-sides":
      return "Confirm the same code on your computer to finish pairing.";
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
