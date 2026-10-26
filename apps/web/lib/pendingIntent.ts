import { safeReturnPath } from "./safeReturnPath";
import { gaEvent } from "./analytics/gtag";
import type { GhostMatchupKey, GhostTarget } from "./ghostBuild";
import type { PracticeInput } from "./practiceAssignment";

export const PENDING_INTENT_KEY = "sc2tools:auth-intent:v1";
export const PENDING_INTENT_TTL = 15 * 60_000;
const MAX_BYTES = 16_384;
type IntentPayloads = {
  "save-build": { slug: string };
  vote: { slug: string; delta: -1 | 1 };
  "arm-ghost": { matchup: GhostMatchupKey; input: PracticeInput };
};
export type IntentKind = keyof IntentPayloads;
export type PendingIntent<K extends IntentKind = IntentKind> = K extends IntentKind ? {
  v: 1; id: string; kind: K; payload: IntentPayloads[K]; path: string; createdAt: number; expiresAt: number;
} : never;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const slug = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function safeTarget(value: unknown): value is GhostTarget {
  const target = object(value);
  return !!target && target.v === 1 && typeof target.name === "string" && target.name.length > 0 && target.name.length <= 80 &&
    Array.isArray(target.steps) && target.steps.length > 0 && target.steps.length <= 80 && target.steps.every(step => {
      const row = object(step);
      return !!row && typeof row.name === "string" && row.name.length > 0 && row.name.length <= 48 && typeof row.t === "number" && Number.isFinite(row.t) && row.t >= 0 && row.t <= 14400 &&
        (row.supply == null || typeof row.supply === "number" && Number.isFinite(row.supply) && row.supply >= 0 && row.supply <= 200);
    });
}

function validPayload(kind: unknown, value: unknown): boolean {
  const payload = object(value); if (!payload) return false;
  if (kind === "save-build" || kind === "vote") return slug(payload.slug) && (kind !== "vote" || payload.delta === -1 || payload.delta === 1);
  if (kind !== "arm-ghost" || typeof payload.matchup !== "string" || !/^[PTZ]v[PTZ]$/.test(payload.matchup)) return false;
  const input = object(payload.input), build = object(input?.build);
  if (!input || !build || input.privateBuild || build.sourceGameId || build.perspective || typeof build.name !== "string" || !build.name.trim() || build.name.length > 80) return false;
  if (build.slug !== undefined && !slug(build.slug)) return false;
  if (input.guideHref !== undefined && (typeof input.guideHref !== "string" || !/^\/guides\/[ptz]v[ptz]\/[a-z0-9-]{1,80}$/.test(input.guideHref))) return false;
  return input.target == null || safeTarget(input.target);
}

function storage(): Storage | null { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } }

/** Only an explicit signed-out action queues an intent. No credentials are stored. */
export function queuePendingIntent<K extends IntentKind>(kind: K, payload: IntentPayloads[K], path: string): boolean {
  const destination = safeReturnPath(path);
  if (!destination || !validPayload(kind, payload)) return false;
  const now = Date.now();
  const intent = { v: 1, id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`, kind, payload, path: destination, createdAt: now, expiresAt: now + PENDING_INTENT_TTL };
  try {
    const json = JSON.stringify(intent); if (new TextEncoder().encode(json).byteLength > MAX_BYTES) return false;
    const target = storage(); if (!target) return false;
    target.setItem(PENDING_INTENT_KEY, json); gaEvent("auth_intent_started", { kind }); return true;
  } catch { return false; }
}

/** A different page cannot consume the pending action. Malformed/expired data
 * is discarded, and the action must be claimed before any asynchronous work. */
export function readPendingIntent<K extends IntentKind>(path: string, kind: K): PendingIntent<K> | null {
  const target = storage(); if (!target) return null;
  try {
    const text = target.getItem(PENDING_INTENT_KEY); if (!text) return null;
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("oversized_intent");
    const intent = object(JSON.parse(text)), now = Date.now();
    if (!intent || intent.v !== 1 || typeof intent.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(intent.id) ||
      typeof intent.createdAt !== "number" || !Number.isSafeInteger(intent.createdAt) || intent.createdAt > now ||
      typeof intent.expiresAt !== "number" || intent.expiresAt !== intent.createdAt + PENDING_INTENT_TTL || intent.expiresAt <= now ||
      safeReturnPath(intent.path) !== intent.path || !validPayload(intent.kind, intent.payload)) throw new Error("invalid_intent");
    return intent.kind === kind && intent.path === safeReturnPath(path) ? intent as PendingIntent<K> : null;
  } catch { try { target.removeItem(PENDING_INTENT_KEY); } catch { /* Storage may be unavailable. */ } return null; }
}

export function claimPendingIntent<K extends IntentKind>(path: string, kind: K): PendingIntent<K> | null {
  const intent = readPendingIntent(path, kind); if (!intent) return null;
  try { const target = storage(); if (!target) return null; target.removeItem(PENDING_INTENT_KEY); return intent; } catch { return null; }
}
