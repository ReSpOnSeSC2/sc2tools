/**
 * Ghost Build — the data layer for the closed practice loop.
 *
 * A streamer picks a TIMED target build ("tonight's homework"). The
 * target travels in the overlay widget URL as a versioned base64url
 * param (``?ghost=<base64url json>``), mirroring the committed
 * ``?theme=`` pattern in lib/overlayTheme.ts: zero server changes, an
 * existing OBS Browser Source keeps working, and the encoded value is
 * treated as HOSTILE input end to end. The same encoded target is also
 * mirrored into localStorage when the user arms it, so the game page
 * can grade the next games against it without any server state (see
 * lib/ghostGrade.ts).
 *
 * SECURITY: the ``?ghost=`` string arrives on an UNAUTHENTICATED
 * overlay page and must be treated as hostile — exactly like
 * ``?theme=``:
 *   - strict validation: versioned envelope, byte-size cap, step-count
 *     cap, per-field type/range checks, control characters stripped
 *     from names, name length caps.
 *   - user input is NEVER interpolated into CSS or markup strings —
 *     names only ever render as React text nodes.
 *   - ANY malformed input (junk base64, bad JSON, wrong version,
 *     oversized payload, invalid steps) silently decodes to ``null``.
 *     The overlay must never paint an error because a viewer tampered
 *     with a URL.
 *
 * Timed steps come from the two surfaces that HAVE times:
 *   - the optimizer's adapted sim ({@link fromOptimizerResult} —
 *     BuildOrderStep {supply, name, kind, startSec}), and
 *   - a game's raw ``[m:ss] Name`` build-log lines
 *     ({@link fromBuildLog} — the same shape lib/build-events.ts and
 *     lib/lossAutopsy.ts already parse).
 */

import type { BuildOrderStep } from "@/lib/optimizer/types";

export const GHOST_BUILD_VERSION = 1;
export const GHOST_BUILD_PARAM = "ghost";
/**
 * localStorage key the "Arm" affordances write and the game page's
 * grading card reads. The stored value is the ENCODED base64url string
 * (not raw JSON) so reads funnel through the exact same hostile-input
 * validation as the URL param.
 */
export const GHOST_BUILD_STORAGE_KEY = "sc2tools:ghost-build:armed";

/** Hard cap on target steps — a practice target is an opening, not a
 * whole game. Constructors slice; the decoder rejects anything over. */
export const MAX_GHOST_STEPS = 80;
/** Per-step entity-name cap ("PhotonCannon" is 12 chars; 48 is roomy). */
const MAX_STEP_NAME_LENGTH = 48;
/** Target (build) display-name cap. */
const MAX_TARGET_NAME_LENGTH = 80;
/**
 * Encoded payloads beyond this length are rejected outright. A maxed
 * target (80 fully-loaded steps) encodes to roughly 6 KB; anything
 * bigger is garbage or an attack. Mirrors overlayTheme's byte cap.
 */
const MAX_ENCODED_LENGTH = 8192;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
/** Step times beyond 4 hours are nonsense for an SC2 build. */
const MAX_STEP_TIME_SEC = 4 * 60 * 60;
/** SC2's hard supply ceiling. */
const MAX_SUPPLY = 200;

/** One timed step of the target build. */
export interface GhostStep {
  /** Supply stamp when the step should start ("21 Adept"), or null
   *  when the source didn't carry one (raw build logs don't). */
  supply: number | null;
  /** Target start time, whole seconds from game start. */
  t: number;
  /** Canonical entity name ("Stargate", "SpawningPool", …). */
  name: string;
}

export interface GhostTarget {
  v: typeof GHOST_BUILD_VERSION;
  /** Display name of the build ("PvZ 2 SG Void Ray (5.0.14)"). */
  name: string;
  steps: GhostStep[];
}

/* ------------------------------------------------------------------ */
/* Name handling                                                       */
/* ------------------------------------------------------------------ */

/**
 * Lowercase and strip everything but letters/digits — the same light
 * normalization lib/salt.ts uses for its alias lookups ("Spawning
 * Pool" → "spawningpool"). Shared with lib/ghostGrade.ts so the
 * grader's greedy matcher agrees with the constructors' worker filter.
 */
export function normalizeGhostName(input: string): string {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Control characters and zero-width junk have no business in a build
 * name; everything else (unicode build titles) survives — names render
 * exclusively as React text nodes, never as markup or CSS. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g;

function sanitizeName(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";
  return input
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Worker/macro units that never belong in a practice target — worker
 * production is macro rhythm, not build-order homework, and including
 * every probe would blow the step cap instantly. */
const WORKER_NAMES: ReadonlySet<string> = new Set([
  "probe",
  "scv",
  "drone",
  "mule",
]);

function isWorkerName(name: string): boolean {
  return WORKER_NAMES.has(normalizeGhostName(name));
}

/* ------------------------------------------------------------------ */
/* Strict validation                                                   */
/* ------------------------------------------------------------------ */

function normalizeStep(input: unknown): GhostStep | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const name = sanitizeName(raw.name, MAX_STEP_NAME_LENGTH);
  if (!name) return null;
  if (typeof raw.t !== "number" || !Number.isFinite(raw.t)) return null;
  const t = Math.round(raw.t);
  if (t < 0 || t > MAX_STEP_TIME_SEC) return null;
  let supply: number | null = null;
  if (raw.supply !== null && raw.supply !== undefined) {
    if (typeof raw.supply !== "number" || !Number.isFinite(raw.supply)) {
      return null;
    }
    supply = Math.min(MAX_SUPPLY, Math.max(0, Math.floor(raw.supply)));
  }
  return { supply, t, name };
}

/**
 * Strict-validate an untrusted value into a {@link GhostTarget}.
 * Unlike overlayTheme (where an invalid field can be dropped and the
 * rest still makes a coherent theme), a build target with a mangled
 * step is WRONG homework — so any invalid step rejects the whole
 * payload. Returns null on anything malformed. Steps are re-sorted by
 * time so downstream consumers can rely on chronological order.
 */
export function normalizeGhostTarget(input: unknown): GhostTarget | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const name = sanitizeName(raw.name, MAX_TARGET_NAME_LENGTH);
  if (!name) return null;
  if (!Array.isArray(raw.steps)) return null;
  if (raw.steps.length === 0 || raw.steps.length > MAX_GHOST_STEPS) {
    return null;
  }
  const steps: GhostStep[] = [];
  for (const entry of raw.steps) {
    const step = normalizeStep(entry);
    if (!step) return null;
    steps.push(step);
  }
  steps.sort((a, b) => a.t - b.t);
  return { v: GHOST_BUILD_VERSION, name, steps };
}

/* ------------------------------------------------------------------ */
/* Encoding — versioned base64url JSON, UTF-8 safe                     */
/* ------------------------------------------------------------------ */

/** UTF-8 → base64url. Plain btoa would throw on non-Latin1 build
 * names, so bytes go through TextEncoder first. */
function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Encode a target as versioned base64url JSON for the ``?ghost=``
 * param (and the localStorage mirror). The input is normalized first
 * so hostile/garbage fields can never be smuggled into a URL. Returns
 * null when the target itself fails validation.
 */
export function encodeGhostTarget(target: GhostTarget): string | null {
  const clean = normalizeGhostTarget(target);
  if (!clean) return null;
  return toBase64Url(JSON.stringify(clean));
}

/**
 * Decode an untrusted ``?ghost=`` value (or the localStorage mirror).
 * ANY failure — junk base64, invalid JSON, wrong version, oversized
 * payload, invalid steps — silently returns null. The overlay must
 * never paint an error because a viewer tampered with a URL.
 */
export function decodeGhostTarget(
  raw: string | null | undefined,
): GhostTarget | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.length > MAX_ENCODED_LENGTH) return null;
  if (!BASE64URL_RE.test(raw)) return null;
  const json = fromBase64Url(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { v?: unknown }).v !== GHOST_BUILD_VERSION
  ) {
    return null;
  }
  return normalizeGhostTarget(parsed);
}

/**
 * Append the ``?ghost=`` param to an overlay widget URL. Invalid or
 * absent targets append nothing so stock URLs stay byte-identical to
 * what streamers already have in OBS.
 */
export function appendGhostToUrl(
  url: string,
  target: GhostTarget | null | undefined,
): string {
  if (!target) return url;
  const encoded = encodeGhostTarget(target);
  if (!encoded) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${GHOST_BUILD_PARAM}=${encoded}`;
}

/* ------------------------------------------------------------------ */
/* Constructors — the two surfaces that have timed steps               */
/* ------------------------------------------------------------------ */

/**
 * Structural subset of the optimizer's AdaptResult that
 * {@link fromOptimizerResult} consumes — every AdaptResult satisfies
 * it, and tests/fixtures don't have to fake a whole sim.
 */
export interface GhostOptimizerSource {
  referenceName: string;
  profileId: string;
  sim: { steps: ReadonlyArray<BuildOrderStep> };
}

/**
 * Build a target from an adapted optimizer result. Keeps
 * build/train/research/morph steps; drops chrono (a macro ability, not
 * a buildable — mirroring toSalt.ts), warpgate transforms (replay
 * build logs never carry them, so they'd grade as permanent misses)
 * and workers. Caps at {@link MAX_GHOST_STEPS}. Returns null when
 * nothing armable remains.
 */
export function fromOptimizerResult(
  result: GhostOptimizerSource,
): GhostTarget | null {
  const steps: GhostStep[] = [];
  for (const step of result.sim.steps) {
    if (step.kind === "chrono" || step.kind === "transform-warpgate") continue;
    if (isWorkerName(step.name)) continue;
    steps.push({
      supply: Number.isFinite(step.supply) ? Math.floor(step.supply) : null,
      t: Math.round(step.startSec),
      name: step.name,
    });
    if (steps.length >= MAX_GHOST_STEPS) break;
  }
  return normalizeGhostTarget({
    v: GHOST_BUILD_VERSION,
    name: `${result.referenceName} (${result.profileId})`,
    steps,
  });
}

/** ``[m:ss] Name`` — the exact shape lib/build-events.ts's
 * buildLogToEvents and lib/lossAutopsy.ts already parse. */
const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;

/**
 * Build a target from a game's raw ``[m:ss] Name`` build-log lines
 * (the my-side log on the game detail page). Lines that don't parse
 * are skipped; workers are dropped (macro rhythm, not homework); raw
 * logs carry no supply stamps so ``supply`` is null. Caps at
 * {@link MAX_GHOST_STEPS}. Returns null when no timed steps survive.
 */
export function fromBuildLog(
  name: string,
  lines: ReadonlyArray<string>,
): GhostTarget | null {
  const steps: GhostStep[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const m = BUILD_LOG_LINE_RE.exec(line);
    if (!m) continue;
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    const entity = m[3];
    if (!entity || isWorkerName(entity)) continue;
    steps.push({ supply: null, t: minutes * 60 + seconds, name: entity });
    if (steps.length >= MAX_GHOST_STEPS) break;
  }
  return normalizeGhostTarget({ v: GHOST_BUILD_VERSION, name, steps });
}

/* ------------------------------------------------------------------ */
/* Arm / disarm — the localStorage mirror                              */
/* ------------------------------------------------------------------ */

/**
 * Arm a target: mirror its ENCODED form into localStorage so the game
 * page can grade the next games and the Settings page can bake it into
 * the copyable widget URL. Returns false when the target is invalid or
 * storage is unavailable (SSR, quota, privacy mode) — arming is a
 * nice-to-have, never a crash.
 */
export function armGhostTarget(target: GhostTarget): boolean {
  const encoded = encodeGhostTarget(target);
  if (!encoded) return false;
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, encoded);
    return true;
  } catch {
    return false;
  }
}

export function disarmGhostTarget(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GHOST_BUILD_STORAGE_KEY);
  } catch {
    // Storage denied — nothing to clean up.
  }
}

/**
 * Read the armed target back, running the stored value through the
 * same hostile-input validation as the URL param (a user — or an
 * extension — can edit localStorage freely). Null when nothing valid
 * is armed.
 */
export function readArmedGhostTarget(): GhostTarget | null {
  if (typeof window === "undefined") return null;
  try {
    return decodeGhostTarget(
      window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}
