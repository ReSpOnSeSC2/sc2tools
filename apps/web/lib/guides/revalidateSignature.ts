/**
 * Verifier for the signed "guides changed" ping the API sends after each
 * nightly guide_stats run (apps/api/src/services/guideRevalidate.js).
 * SERVER ONLY (node:crypto); used by app/api/revalidate-guides.
 *
 * Wire format, exactly as the API signs it:
 *   header  x-sc2tools-signature: sha256=<hex HMAC-SHA256(secret, `${ts}.${rawBody}`)>
 *   body    {"ts":<epoch MILLISECONDS>,"scope":"guides"}
 * The digest is compared with crypto.timingSafeEqual, and `ts` must be
 * within ±5 minutes of this server's clock so a captured ping can't be
 * replayed later.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const GUIDE_REVALIDATE_SIGNATURE_HEADER = "x-sc2tools-signature";
export const GUIDE_REVALIDATE_SCOPE = "guides";
/** Accepted clock skew between the API and this server, in milliseconds (±5 min). */
export const GUIDE_REVALIDATE_MAX_SKEW_MS = 5 * 60 * 1000;
/** The real body is ~40 bytes; anything much larger is not ours. */
export const GUIDE_REVALIDATE_MAX_BODY_BYTES = 4096;

const SIGNATURE_PREFIX = "sha256=";
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

export type GuideRevalidateVerdict =
  | { ok: true; scope: unknown }
  | { ok: false; reason: "bad_signature" | "stale" };

interface PingBody {
  ts: number;
  scope: unknown;
}

function parseBody(rawBody: string): PingBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { ts, scope } = parsed as { ts?: unknown; scope?: unknown };
  return typeof ts === "number" && Number.isSafeInteger(ts) ? { ts, scope } : null;
}

function signatureMatches(secret: string, header: string | null, signedText: string): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const given = header.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!HEX_SHA256_RE.test(given)) return false;
  const expected = createHmac("sha256", secret).update(signedText, "utf8").digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected);
}

/**
 * Check one ping. The signature is verified before the clock, so an
 * unsigned request learns nothing about the accepted window.
 *
 * Example: a body signed by the API a second ago → `{ ok: true, scope: "guides" }`;
 * the same body with one byte changed → `{ ok: false, reason: "bad_signature" }`.
 */
export function verifyGuideRevalidation(
  secret: string,
  signatureHeader: string | null,
  rawBody: string,
  nowMs: number,
): GuideRevalidateVerdict {
  const body = parseBody(rawBody);
  if (!body || !signatureMatches(secret, signatureHeader, `${body.ts}.${rawBody}`)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (Math.abs(nowMs - body.ts) > GUIDE_REVALIDATE_MAX_SKEW_MS) return { ok: false, reason: "stale" };
  return { ok: true, scope: body.scope };
}
