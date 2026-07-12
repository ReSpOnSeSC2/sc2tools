/**
 * Ghost Build — the data layer for the closed practice loop.
 *
 * A streamer picks a TIMED target build ("tonight's homework"). The
 * target travels in the overlay widget URL as versioned base64url data.
 * New v2 loadouts use ``#ghost=<base64url json>`` so the potentially large
 * nine-matchup payload never leaves the browser; legacy v1 links retain
 * their original ``?ghost=`` shape. The encoded value is treated as HOSTILE
 * input end to end. The same encoded target is also
 * mirrored into localStorage when the user arms it, so the game page
 * can grade the next games against it without any server state (see
 * lib/ghostGrade.ts).
 *
 * SECURITY: the ``ghost`` string arrives on an UNAUTHENTICATED
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
import {
  MATCHUPS,
  isMatchupKey,
  type MatchupKey,
} from "@/lib/randomizer/types";

export const GHOST_BUILD_VERSION = 1;
export const GHOST_BUILD_CONFIG_VERSION = 2;
export const GHOST_BUILD_PARAM = "ghost";
/**
 * localStorage key the "Arm" affordances write and the game page's
 * grading card reads. The stored value is the ENCODED base64url string
 * (not raw JSON) so reads funnel through the exact same hostile-input
 * validation as the URL param.
 */
export const GHOST_BUILD_STORAGE_KEY = "sc2tools:ghost-build:armed";
/** Local library of prior exact-matchup targets. The URL remains fully
 * self-contained; this library only powers the authenticated settings UI. */
export const GHOST_BUILD_LIBRARY_STORAGE_KEY =
  "sc2tools:ghost-build:saved:v2";

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
/** Compact v2 loadouts may carry one max-sized target for each of the nine
 * concrete matchups. Cap at 64 KiB so malformed fragments are rejected before
 * base64 decoding allocates a large intermediate string. */
const MAX_CONFIG_ENCODED_LENGTH = 64 * 1024;
/** Allows the field name and a few small coexisting fragment flags without
 * letting URLSearchParams allocate against an attacker-controlled giant hash. */
const MAX_GHOST_FRAGMENT_LENGTH = MAX_CONFIG_ENCODED_LENGTH + 256;
const MAX_SAVED_GHOST_BUILDS = 100;
const MAX_LIBRARY_JSON_LENGTH = 2 * 1024 * 1024;
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

/** Only concrete races can select homework. Random, unknown and empty values
 * intentionally normalize to null rather than a fallback race. */
export type GhostConcreteRace = "P" | "T" | "Z";

/** Streamer-perspective exact matchup (own race first). Re-exported as a
 * Ghost-specific name so consumers do not need to couple to Randomizer. */
export type GhostMatchupKey = MatchupKey;

/** Stable display/serialization order, grouped by the streamer's race. */
export const GHOST_MATCHUPS: ReadonlyArray<GhostMatchupKey> = MATCHUPS;

/** Versioned public model. Undefined keys are deliberately unassigned; there
 * is no catch-all target because that could coach the wrong matchup. */
export interface GhostBuildConfig {
  v: typeof GHOST_BUILD_CONFIG_VERSION;
  slots: Partial<Record<GhostMatchupKey, GhostTarget>>;
}

/** A locally saved target that can be assigned to any exact slot by Settings.
 * `matchup` records the matchup the build came from and is always concrete. */
export interface SavedGhostBuild {
  id: string;
  matchup: GhostMatchupKey;
  target: GhostTarget;
  savedAt: string;
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

/** Normalize only the six wire spellings SC2Tools emits. Deliberately avoid
 * first-letter coercion: values such as "random", "unknown" and "?" must
 * never accidentally select a build. */
export function normalizeConcreteGhostRace(
  input: unknown,
): GhostConcreteRace | null {
  if (typeof input !== "string") return null;
  switch (input.trim().toLowerCase()) {
    case "p":
    case "protoss":
      return "P";
    case "t":
    case "terran":
      return "T";
    case "z":
    case "zerg":
      return "Z";
    default:
      return null;
  }
}

/** Form an exact streamer-perspective matchup, or null unless both sides are
 * concrete. This is the single gate runtime consumers should use. */
export function ghostMatchupKey(
  myRace: unknown,
  opponentRace: unknown,
): GhostMatchupKey | null {
  const mine = normalizeConcreteGhostRace(myRace);
  const theirs = normalizeConcreteGhostRace(opponentRace);
  if (!mine || !theirs) return null;
  const key = `${mine}v${theirs}`;
  return isMatchupKey(key) ? key : null;
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
  if (raw.v !== GHOST_BUILD_VERSION) return null;
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

export function emptyGhostBuildConfig(): GhostBuildConfig {
  return { v: GHOST_BUILD_CONFIG_VERSION, slots: {} };
}

/** Strictly normalize the public (expanded) v2 model. Unknown slot keys and
 * invalid nested targets reject the whole object rather than producing a
 * partially wrong practice plan. */
export function normalizeGhostBuildConfig(
  input: unknown,
): GhostBuildConfig | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  if (raw.v !== GHOST_BUILD_CONFIG_VERSION) return null;
  if (
    typeof raw.slots !== "object"
    || raw.slots === null
    || Array.isArray(raw.slots)
  ) {
    return null;
  }
  const rawSlots = raw.slots as Record<string, unknown>;
  if (Object.keys(rawSlots).some((key) => !isMatchupKey(key))) return null;

  const slots: Partial<Record<GhostMatchupKey, GhostTarget>> = {};
  for (const matchup of GHOST_MATCHUPS) {
    if (!Object.prototype.hasOwnProperty.call(rawSlots, matchup)) continue;
    const target = normalizeGhostTarget(rawSlots[matchup]);
    if (!target) return null;
    slots[matchup] = target;
  }
  return { v: GHOST_BUILD_CONFIG_VERSION, slots };
}

/** Select only an exact 3x3 slot. Random/unknown on either side and missing
 * assignments all return null; there is intentionally no legacy fallback. */
export function selectGhostTarget(
  config: GhostBuildConfig | null | undefined,
  myRace: unknown,
  opponentRace: unknown,
): GhostTarget | null {
  const matchup = ghostMatchupKey(myRace, opponentRace);
  if (!matchup || !config) return null;
  const clean = normalizeGhostBuildConfig(config);
  return clean?.slots[matchup] ?? null;
}

/** Return a fresh config with one exact slot assigned. Invalid public input is
 * treated as an empty config, while an invalid matchup/target is a no-op. */
export function assignGhostTarget(
  config: GhostBuildConfig | null | undefined,
  matchup: GhostMatchupKey,
  target: GhostTarget,
): GhostBuildConfig {
  const base = normalizeGhostBuildConfig(config) ?? emptyGhostBuildConfig();
  if (!isMatchupKey(matchup)) return base;
  const cleanTarget = normalizeGhostTarget(target);
  if (!cleanTarget) return base;
  return {
    v: GHOST_BUILD_CONFIG_VERSION,
    slots: { ...base.slots, [matchup]: cleanTarget },
  };
}

export function assignSavedGhostBuild(
  config: GhostBuildConfig | null | undefined,
  matchup: GhostMatchupKey,
  build: SavedGhostBuild,
): GhostBuildConfig {
  return assignGhostTarget(config, matchup, build.target);
}

export function clearGhostTarget(
  config: GhostBuildConfig | null | undefined,
  matchup: GhostMatchupKey,
): GhostBuildConfig {
  const base = normalizeGhostBuildConfig(config) ?? emptyGhostBuildConfig();
  if (!isMatchupKey(matchup) || !base.slots[matchup]) return base;
  const slots = { ...base.slots };
  delete slots[matchup];
  return { v: GHOST_BUILD_CONFIG_VERSION, slots };
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

/** Compact URL-only target tuple: [display name, [[supply,time,name], ...]].
 * Public callers always work with GhostTarget; this shape never leaks out of
 * the codec. */
type CompactGhostTarget = [
  string,
  Array<[number | null, number, string]>,
];

function compactTarget(target: GhostTarget): CompactGhostTarget {
  return [
    target.name,
    target.steps.map((step) => [step.supply, step.t, step.name]),
  ];
}

function expandCompactTarget(input: unknown): GhostTarget | null {
  if (!Array.isArray(input) || input.length !== 2 || !Array.isArray(input[1])) {
    return null;
  }
  const rawSteps = input[1] as unknown[];
  const steps: unknown[] = [];
  for (const rawStep of rawSteps) {
    if (!Array.isArray(rawStep) || rawStep.length !== 3) return null;
    steps.push({ supply: rawStep[0], t: rawStep[1], name: rawStep[2] });
  }
  return normalizeGhostTarget({
    v: GHOST_BUILD_VERSION,
    name: input[0],
    steps,
  });
}

/** Encode a v2 exact-matchup loadout into a compact, deterministic payload.
 * Slots serialize in GHOST_MATCHUPS order and field names are shortened only
 * on the wire, keeping copied OBS URLs substantially smaller than expanded
 * JSON. Empty configs append nothing and therefore encode to null. */
export function encodeGhostBuildConfig(
  config: GhostBuildConfig,
): string | null {
  const clean = normalizeGhostBuildConfig(config);
  if (!clean) return null;
  const builds: Partial<Record<GhostMatchupKey, CompactGhostTarget>> = {};
  for (const matchup of GHOST_MATCHUPS) {
    const target = clean.slots[matchup];
    if (target) builds[matchup] = compactTarget(target);
  }
  if (Object.keys(builds).length === 0) return null;
  const encoded = toBase64Url(
    JSON.stringify({ v: GHOST_BUILD_CONFIG_VERSION, b: builds }),
  );
  return encoded.length <= MAX_CONFIG_ENCODED_LENGTH ? encoded : null;
}

/** Strict-decode only the compact v2 loadout. A legacy v1 single-target URL
 * remains available through decodeGhostTarget for migration/display, but is
 * never expanded into all nine matchups. */
export function decodeGhostBuildConfig(
  raw: string | null | undefined,
): GhostBuildConfig | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.length > MAX_CONFIG_ENCODED_LENGTH || !BASE64URL_RE.test(raw)) {
    return null;
  }
  const json = fromBase64Url(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== GHOST_BUILD_CONFIG_VERSION) return null;
  if (Object.keys(obj).some((key) => key !== "v" && key !== "b")) return null;
  if (typeof obj.b !== "object" || obj.b === null || Array.isArray(obj.b)) {
    return null;
  }
  const rawBuilds = obj.b as Record<string, unknown>;
  const keys = Object.keys(rawBuilds);
  if (keys.length === 0 || keys.some((key) => !isMatchupKey(key))) return null;

  const slots: Partial<Record<GhostMatchupKey, GhostTarget>> = {};
  for (const matchup of GHOST_MATCHUPS) {
    if (!Object.prototype.hasOwnProperty.call(rawBuilds, matchup)) continue;
    const target = expandCompactTarget(rawBuilds[matchup]);
    if (!target) return null;
    slots[matchup] = target;
  }
  return normalizeGhostBuildConfig({
    v: GHOST_BUILD_CONFIG_VERSION,
    slots,
  });
}

/**
 * Read and validate a v2 Ghost loadout from a URL fragment. Fragments are
 * client-only and are never included in the HTTP request to the overlay
 * route, which keeps a nine-matchup payload clear of host/proxy URL limits.
 *
 * Exactly one ``ghost`` field is accepted. Duplicate or malformed values
 * are treated as unarmed, and legacy v1 values intentionally remain a query-
 * string-only compatibility path.
 */
export function readGhostBuildParamFromHash(
  hash: string | null | undefined,
): string | null {
  if (typeof hash !== "string" || hash.length === 0) return null;
  if (hash.length > MAX_GHOST_FRAGMENT_LENGTH) return null;
  let rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (rawHash.startsWith("?")) rawHash = rawHash.slice(1);
  if (!rawHash) return null;

  const values = new URLSearchParams(rawHash).getAll(GHOST_BUILD_PARAM);
  if (values.length !== 1) return null;
  const value = values[0];
  return decodeGhostBuildConfig(value) ? value : null;
}

function appendQueryParam(url: string, name: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}${name}=${value}${hash}`;
}

function appendFragmentParam(url: string, name: string, value: string): string {
  const hashIndex = url.indexOf("#");
  if (hashIndex < 0 || hashIndex === url.length - 1) {
    return `${hashIndex < 0 ? url : url.slice(0, -1)}#${name}=${value}`;
  }
  const separator = url.endsWith("&") ? "" : "&";
  return `${url}${separator}${name}=${value}`;
}

/**
 * Append Ghost data to an overlay widget URL. V2 exact-matchup configs use a
 * client-only fragment; legacy v1 targets keep ``?ghost=`` so existing copied
 * OBS links remain byte-compatible. Invalid or absent payloads append nothing.
 */
export function appendGhostToUrl(
  url: string,
  payload: GhostTarget | GhostBuildConfig | null | undefined,
): string {
  if (!payload) return url;
  const isConfig = payload.v === GHOST_BUILD_CONFIG_VERSION;
  const encoded = isConfig
    ? encodeGhostBuildConfig(payload as GhostBuildConfig)
    : encodeGhostTarget(payload as GhostTarget);
  if (!encoded) return url;
  return isConfig
    ? appendFragmentParam(url, GHOST_BUILD_PARAM, encoded)
    : appendQueryParam(url, GHOST_BUILD_PARAM, encoded);
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
/* Exact-matchup arming + local saved-build library                    */
/* ------------------------------------------------------------------ */

/** Read v2 only; legacy v1 remains available through
 * readArmedGhostTarget for an explicit migration flow. */
export function readArmedGhostConfig(): GhostBuildConfig | null {
  if (typeof window === "undefined") return null;
  try {
    return decodeGhostBuildConfig(
      window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

/** Persist a v2 config. An empty config means "nothing armed" and removes the
 * key so Settings emits the stock URL without a ghost query parameter. */
export function writeArmedGhostConfig(config: GhostBuildConfig): boolean {
  const clean = normalizeGhostBuildConfig(config);
  if (!clean || typeof window === "undefined") return false;
  const encoded = encodeGhostBuildConfig(clean);
  const hasAssignments = Object.keys(clean.slots).length > 0;
  // `null` means either a deliberate empty config or a payload that cannot
  // be represented safely. Never mistake an oversized non-empty loadout for
  // "clear everything" and erase the user's existing assignments.
  if (hasAssignments && !encoded) return false;
  try {
    if (encoded) {
      window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, encoded);
    } else {
      window.localStorage.removeItem(GHOST_BUILD_STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearArmedGhostConfig(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GHOST_BUILD_STORAGE_KEY);
  } catch {
    // Storage denied — nothing to clean up.
  }
}

/** Explicit migration helper. A legacy target is safe to migrate only when a
 * caller supplies the exact matchup; target names are never parsed/guessed. */
export function migrateLegacyGhostTarget(
  target: GhostTarget,
  matchup: GhostMatchupKey,
): GhostBuildConfig {
  return assignGhostTarget(emptyGhostBuildConfig(), matchup, target);
}

/**
 * Transactionally migrate the legacy single-build localStorage value into one
 * explicit v2 matchup and the saved-build library. The currently stored v1
 * target must still match the target the Settings UI presented; this prevents
 * a stale tab from overwriting a newer v2 loadout. The underlying arming helper
 * restores both storage keys if either write fails, so the v1 value survives a
 * denied/full storage error unchanged.
 */
export function migrateLegacyGhostTargetInStorage(
  target: GhostTarget,
  matchup: GhostMatchupKey,
): boolean {
  if (!isMatchupKey(matchup)) return false;
  const storedTarget = readArmedGhostTarget();
  if (!storedTarget) return false;
  const expected = encodeGhostTarget(target);
  const stored = encodeGhostTarget(storedTarget);
  if (!expected || stored !== expected) return false;
  return armGhostTargetForMatchup(matchup[0], matchup[2], target);
}

const SAVED_ID_RE = /^[A-Za-z0-9:-]{1,128}$/;

function normalizeSavedGhostBuild(input: unknown): SavedGhostBuild | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !SAVED_ID_RE.test(raw.id)) return null;
  if (!isMatchupKey(raw.matchup)) return null;
  if (typeof raw.savedAt !== "string" || raw.savedAt.length > 40) return null;
  const savedAtMs = Date.parse(raw.savedAt);
  if (!Number.isFinite(savedAtMs)) return null;
  const target = normalizeGhostTarget(raw.target);
  if (!target) return null;
  return {
    id: raw.id,
    matchup: raw.matchup,
    target,
    savedAt: new Date(savedAtMs).toISOString(),
  };
}

function normalizeSavedGhostBuilds(input: unknown): SavedGhostBuild[] | null {
  if (!Array.isArray(input) || input.length > MAX_SAVED_GHOST_BUILDS) return null;
  const builds: SavedGhostBuild[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    const build = normalizeSavedGhostBuild(raw);
    if (!build || ids.has(build.id)) return null;
    ids.add(build.id);
    builds.push(build);
  }
  builds.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return builds;
}

export function readSavedGhostBuilds(): SavedGhostBuild[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(GHOST_BUILD_LIBRARY_STORAGE_KEY);
    if (!raw || raw.length > MAX_LIBRARY_JSON_LENGTH) return [];
    return normalizeSavedGhostBuilds(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

function savedBuildJson(builds: SavedGhostBuild[]): string | null {
  const clean = normalizeSavedGhostBuilds(builds);
  if (!clean) return null;
  const json = JSON.stringify(clean);
  return json.length <= MAX_LIBRARY_JSON_LENGTH ? json : null;
}

function targetFingerprint(target: GhostTarget): string {
  // Small deterministic FNV-1a id: exact duplicates update their savedAt
  // instead of filling the library with repeated copies of one replay build.
  const input = JSON.stringify(compactTarget(target));
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function newSavedGhostBuild(
  matchup: GhostMatchupKey,
  target: GhostTarget,
): SavedGhostBuild {
  return {
    id: `${matchup}:${targetFingerprint(target)}`,
    matchup,
    target,
    savedAt: new Date().toISOString(),
  };
}

function withSavedBuild(
  builds: SavedGhostBuild[],
  entry: SavedGhostBuild,
): SavedGhostBuild[] {
  return [entry, ...builds.filter((build) => build.id !== entry.id)]
    .slice(0, MAX_SAVED_GHOST_BUILDS);
}

export function saveGhostBuild(
  matchup: GhostMatchupKey,
  target: GhostTarget,
): SavedGhostBuild | null {
  if (!isMatchupKey(matchup) || typeof window === "undefined") return null;
  const cleanTarget = normalizeGhostTarget(target);
  if (!cleanTarget) return null;
  const entry = newSavedGhostBuild(matchup, cleanTarget);
  const json = savedBuildJson(withSavedBuild(readSavedGhostBuilds(), entry));
  if (!json) return null;
  try {
    window.localStorage.setItem(GHOST_BUILD_LIBRARY_STORAGE_KEY, json);
    return entry;
  } catch {
    return null;
  }
}

export function removeSavedGhostBuild(id: string): boolean {
  if (typeof window === "undefined" || !SAVED_ID_RE.test(id)) return false;
  const current = readSavedGhostBuilds();
  const next = current.filter((build) => build.id !== id);
  if (next.length === current.length) return false;
  const json = savedBuildJson(next);
  if (json === null) return false;
  try {
    if (next.length === 0) {
      window.localStorage.removeItem(GHOST_BUILD_LIBRARY_STORAGE_KEY);
    } else {
      window.localStorage.setItem(GHOST_BUILD_LIBRARY_STORAGE_KEY, json);
    }
    return true;
  } catch {
    return false;
  }
}

function restoreStorageValue(key: string, previous: string | null): void {
  try {
    if (previous === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, previous);
  } catch {
    // Best-effort rollback when storage itself is unavailable.
  }
}

/** Game-detail primary action: save the build to the local library and assign
 * it to the exact matchup in one rollback-safe localStorage transaction. */
export function armGhostTargetForMatchup(
  myRace: unknown,
  opponentRace: unknown,
  target: GhostTarget,
): boolean {
  const matchup = ghostMatchupKey(myRace, opponentRace);
  const cleanTarget = normalizeGhostTarget(target);
  if (!matchup || !cleanTarget || typeof window === "undefined") return false;

  const config = assignGhostTarget(
    readArmedGhostConfig() ?? emptyGhostBuildConfig(),
    matchup,
    cleanTarget,
  );
  const encodedConfig = encodeGhostBuildConfig(config);
  const entry = newSavedGhostBuild(matchup, cleanTarget);
  const libraryJson = savedBuildJson(
    withSavedBuild(readSavedGhostBuilds(), entry),
  );
  if (!encodedConfig || !libraryJson) return false;

  let previousConfig: string | null;
  let previousLibrary: string | null;
  try {
    previousConfig = window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY);
    previousLibrary = window.localStorage.getItem(
      GHOST_BUILD_LIBRARY_STORAGE_KEY,
    );
  } catch {
    return false;
  }
  try {
    window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, encodedConfig);
    window.localStorage.setItem(GHOST_BUILD_LIBRARY_STORAGE_KEY, libraryJson);
    return true;
  } catch {
    restoreStorageValue(GHOST_BUILD_STORAGE_KEY, previousConfig);
    restoreStorageValue(GHOST_BUILD_LIBRARY_STORAGE_KEY, previousLibrary);
    return false;
  }
}

/** @deprecated Use armGhostTargetForMatchup so a build cannot leak into the
 * wrong matchup. Retained while older pages transition to v2. */
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
  clearArmedGhostConfig();
}

/**
 * Read the armed target back, running the stored value through the
 * same hostile-input validation as the URL param (a user — or an
 * extension — can edit localStorage freely). A v2 config intentionally
 * returns null because choosing from it without both races would be unsafe.
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
