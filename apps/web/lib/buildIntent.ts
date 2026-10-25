"use client";

/**
 * Build check-in ("build intent") — web types and helpers.
 *
 * A confirmed check-in makes a game count toward the build the player
 * declared, even when the replay classifier labelled it as something
 * else. The shapes below mirror the API contract one to one
 * (apps/api/src/routes/buildIntents.js and the per-game
 * `/v1/games/:gameId/build-intent` routes); the helpers translate them
 * into UI copy and wrap the mutations around `apiCall`.
 */

import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import type { CheckInSide } from "@/lib/buildIntentLinks";

export {
  NEW_BUILD_QUERY_PARAM,
  newBuildHref,
  type CheckInSide,
} from "@/lib/buildIntentLinks";

/* ------------------------------------------------------------------
 * Contract types
 * ------------------------------------------------------------------ */

export type BuildSource = "catalog" | "custom";

/** `catalog` keys are `slugifyDef(name)`; custom keys are `custom:<slug>`. */
export interface BuildRef {
  key: string;
  name: string;
  slug: string | null;
  source: BuildSource;
}

export type SuggestionReason =
  | "declared"
  | "randomizer"
  | "detected"
  | "rules"
  | "usual";

export interface BuildSuggestion extends BuildRef {
  reason: SuggestionReason;
  passedRules: number | null;
  ruleCount: number | null;
}

/** One row of the build list for a matchup (`GET /v1/build-intents/options`). */
export interface BuildOption extends BuildRef {
  games: number;
  wins: number;
  losses: number;
  checkins: number;
  lastPlayedAt: string | null;
  inRandomizer: boolean;
  /** "yours" = custom, played, or in the randomizer pool; everything else is the catalog. */
  group: "yours" | "all";
  /** Present for custom builds only. */
  ruleCount?: number | null;
}

export interface BuildOptionsResponse {
  matchup: string;
  /** Which list this is; absent on older APIs (= "you"). */
  side?: CheckInSide;
  randomizerEnabled: boolean;
  usualKey: string | null;
  builds: BuildOption[];
}

/** Cloud preference `buildCheckin`; every prompt requires an opt-in. */
export interface BuildCheckinPrefs {
  enabled: boolean;
  askAtLoading: boolean;
  askAfterGame: boolean;
}

export type BuildIntentStatus = "none" | "pending" | "confirmed" | "skipped";

export type IneligibleReason = "resumed" | "not_1v1" | "no_matchup" | "too_short";

export type BuildIntentOrigin = "pregame" | "postgame" | "web";

export type BuildIntentVia = "agent" | "web";

/** The opponent's build as the replay suggests it (only ever "detected" or "rules"). */
export interface OpponentBuildSuggestion extends BuildRef {
  reason: Extract<SuggestionReason, "detected" | "rules">;
  passedRules: number | null;
  ruleCount: number | null;
}

/**
 * The opponent axis of a game's check-in: an optional correction of the
 * opponent's build. There is no pending state or queue for this side.
 */
export interface OpponentIntentState {
  /** The effective `opponent.strategy` (the correction while applied); null when none. */
  label: string | null;
  status: "none" | "confirmed";
  /** `deleted: true` when the chosen custom build was later deleted (frozen). */
  build: (BuildRef & { deleted?: boolean }) | null;
  /** True only while the game's opponent label carries `build`. */
  applied: boolean;
  /** The classifier's opponent label; `key` is set when it is a pickable option. */
  detected: { name: string | null; slug: string | null; key: string | null } | null;
  suggestion: OpponentBuildSuggestion | null;
  /** Whether the replay agrees with the correction; null when there is none. */
  executed: boolean | null;
  /** Only with `?include=options` (never on pending-queue items). */
  options?: BuildOption[];
}

/** `GET/PUT /v1/games/:gameId/build-intent`. */
export interface GameIntentState {
  gameId: string;
  matchup: string | null;
  myRace: string | null;
  oppRace: string | null;
  result: string | null;
  date: string | null;
  durationSec: number | null;
  map: string | null;
  oppName: string | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  status: BuildIntentStatus;
  applied: boolean;
  /** `deleted: true` when the confirmed custom build was later deleted (frozen). */
  build: (BuildRef & { deleted?: boolean }) | null;
  suggestion: BuildSuggestion | null;
  randomizer: BuildRef | null;
  randomizerDeviated: boolean;
  /** The classifier's label; `key` is set when that label is a pickable option. */
  detected: { name: string | null; slug: string | null; key: string | null } | null;
  executed: boolean;
  notes: string;
  origin: BuildIntentOrigin | null;
  via: BuildIntentVia | null;
  confirmedAt: string | null;
  updatedAt: string | null;
  prefs: BuildCheckinPrefs;
  /** Only with `?include=options`. */
  options?: BuildOption[];
  usualKey?: string | null;
  /**
   * The opponent's build; null when the game has no concrete matchup
   * (absent on APIs that predate the opponent axis).
   */
  opponent?: OpponentIntentState | null;
}

/** `GET /v1/build-intents/pending`. */
export interface PendingIntentsResponse {
  items: GameIntentState[];
  total: number;
  disabled: boolean;
}

export interface DismissPendingResponse {
  dismissed: number;
}

export type GameIntentAction = "confirm" | "skip" | "defer" | "notes" | "opponent";

/**
 * `PUT /v1/games/:gameId/build-intent` body; omitted `notes` = unchanged.
 * `opponentBuildKey` rides along with any action: a key corrects the
 * opponent's build, `null` goes back to the replay's label, omitted keeps
 * it. The "opponent" action changes only that (the key is required).
 */
export interface GameIntentRequest {
  action: GameIntentAction;
  buildKey?: string;
  notes?: string;
  opponentBuildKey?: string | null;
}

/** `GET/PUT /v1/build-intents/live/:gameKey` (agent surface; typed for completeness). */
export interface LiveIntentState {
  gameKey: string;
  matchup: string | null;
  myRace: string | null;
  oppRace: string | null;
  oppName: string | null;
  declared: (BuildRef & { at: string; via: BuildIntentVia }) | null;
  randomizer: BuildRef | null;
  randomizerEnabled: boolean;
  holdRemainingMs: number;
  gameId: string | null;
  prefs: BuildCheckinPrefs;
}

/* ------------------------------------------------------------------
 * Constants and paths
 * ------------------------------------------------------------------ */

/** Mirrors the API's NOTES_MAX_LENGTH (buildIntentShape.js). */
export const BUILD_INTENT_NOTES_MAX_LENGTH = 1000;
/** The pending queue covers games from this many hours back. */
export const PENDING_WINDOW_HOURS = 72;
export const PENDING_LIMIT_MAX = 25;
export const BUILD_CHECKIN_PREFS_PATH = "/v1/me/preferences/buildCheckin";
export const PENDING_DISMISS_PATH = "/v1/build-intents/pending/dismiss";
/** Settings deep link for the check-in toggles. */
export const BUILD_CHECKIN_SETTINGS_HREF = "/settings?tab=checkin";

export const DEFAULT_CHECKIN_PREFS: BuildCheckinPrefs = {
  enabled: false,
  askAtLoading: false,
  askAfterGame: false,
};

const MATCHUP_RE = /^[PTZ]v[PTZ]$/;

/**
 * Example: `gameIntentPath("a|b c", { includeOptions: true })` →
 * "/v1/games/a%7Cb%20c/build-intent?include=options".
 */
export function gameIntentPath(
  gameId: string,
  { includeOptions = false }: { includeOptions?: boolean } = {},
): string {
  const base = `/v1/games/${encodeURIComponent(gameId)}/build-intent`;
  return includeOptions ? `${base}?include=options` : base;
}

/** Example: `pendingIntentsPath(99)` → "/v1/build-intents/pending?limit=25". */
export function pendingIntentsPath(limit = 10): string {
  const safe = Math.min(PENDING_LIMIT_MAX, Math.max(1, Math.floor(limit) || 1));
  return `/v1/build-intents/pending?limit=${safe}`;
}

/**
 * Null for anything that is not a concrete matchup such as "PvZ". The
 * opponent list is the builds the opponent can go for in that matchup.
 *
 * Example: `buildOptionsPath("PvZ", "opponent")` →
 * "/v1/build-intents/options?matchup=PvZ&side=opponent".
 */
export function buildOptionsPath(
  matchup: string | null | undefined,
  side: CheckInSide = "you",
): string | null {
  if (!matchup || !MATCHUP_RE.test(matchup)) return null;
  const base = `/v1/build-intents/options?matchup=${encodeURIComponent(matchup)}`;
  return side === "opponent" ? `${base}&side=opponent` : base;
}

/** Example: `customBuildKey("dt-3-gate")` → "custom:dt-3-gate". */
export function customBuildKey(slug: string): string {
  return `custom:${slug}`;
}

/**
 * Append the check-in revision as a URL fragment. The fragment changes the
 * SWR key (so a `build-intent:changed` ping refetches) but is never sent to
 * the API — the same trick the analyzer uses with `dbRev`.
 *
 * Example: `withRevision("/v1/x", 3)` → "/v1/x#checkin-3".
 */
export function withRevision(path: string, revision: number): string {
  return `${path}#checkin-${revision}`;
}

/* ------------------------------------------------------------------
 * Data hooks
 * ------------------------------------------------------------------ */

/** One game's check-in state, with its build list. Null `gameId` skips. */
export function useGameBuildIntent(gameId: string | null, revision: number) {
  return useApi<GameIntentState>(
    gameId ? withRevision(gameIntentPath(gameId, { includeOptions: true }), revision) : null,
    { keepPreviousData: true, revalidateOnFocus: false, shouldRetryOnError: false },
  );
}

/** The pending queue (`limit` 1–25). Null `limit` skips the request. */
export function usePendingIntents(limit: number | null, revision: number) {
  return useApi<PendingIntentsResponse>(
    limit == null ? null : withRevision(pendingIntentsPath(limit), revision),
    { keepPreviousData: true, revalidateOnFocus: true, shouldRetryOnError: false },
  );
}

/**
 * Build list for one matchup and side; null skips. The revision refetches
 * the list after a check-in write (records and new builds change).
 */
export function useBuildOptions(
  matchup: string | null,
  { side = "you", revision = 0 }: { side?: CheckInSide; revision?: number } = {},
) {
  const path = buildOptionsPath(matchup, side);
  return useApi<BuildOptionsResponse>(path ? withRevision(path, revision) : null, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });
}

/* ------------------------------------------------------------------
 * Mutations
 * ------------------------------------------------------------------ */

type TokenGetter = () => Promise<string | null>;

export function putGameIntent(
  getToken: TokenGetter,
  gameId: string,
  body: GameIntentRequest,
): Promise<GameIntentState> {
  return apiCall<GameIntentState>(getToken, gameIntentPath(gameId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Extra fields a "you"-side write can carry in the same request. */
export interface GameIntentWriteOptions {
  /** A key corrects the opponent's build, null restores the replay's label. */
  opponentBuildKey?: string | null;
}

function withOptionalFields(
  notes: string | undefined,
  opts: GameIntentWriteOptions | undefined,
): Pick<GameIntentRequest, "notes" | "opponentBuildKey"> {
  return {
    ...(notes === undefined ? {} : { notes }),
    ...(opts?.opponentBuildKey === undefined ? {} : { opponentBuildKey: opts.opponentBuildKey }),
  };
}

export function confirmGameIntent(
  getToken: TokenGetter,
  gameId: string,
  buildKey: string,
  notes?: string,
  opts?: GameIntentWriteOptions,
): Promise<GameIntentState> {
  return putGameIntent(getToken, gameId, {
    action: "confirm",
    buildKey,
    ...withOptionalFields(notes, opts),
  });
}

/** "No set build": the game keeps the replay's own label. */
export function skipGameIntent(
  getToken: TokenGetter,
  gameId: string,
  notes?: string,
  opts?: GameIntentWriteOptions,
): Promise<GameIntentState> {
  return putGameIntent(getToken, gameId, {
    action: "skip",
    ...withOptionalFields(notes, opts),
  });
}

/**
 * Correct the opponent's build only (`null` = use the replay's label);
 * the player's own check-in is left as it is.
 */
export function setOpponentBuild(
  getToken: TokenGetter,
  gameId: string,
  opponentBuildKey: string | null,
  notes?: string,
): Promise<GameIntentState> {
  return putGameIntent(getToken, gameId, {
    action: "opponent",
    opponentBuildKey,
    ...(notes === undefined ? {} : { notes }),
  });
}

export function saveGameIntentNotes(
  getToken: TokenGetter,
  gameId: string,
  notes: string,
): Promise<GameIntentState> {
  return putGameIntent(getToken, gameId, { action: "notes", notes });
}

export function dismissPendingIntents(
  getToken: TokenGetter,
): Promise<DismissPendingResponse> {
  return apiCall<DismissPendingResponse>(getToken, PENDING_DISMISS_PATH, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function putCheckinPrefs(
  getToken: TokenGetter,
  prefs: BuildCheckinPrefs,
): Promise<BuildCheckinPrefs> {
  const body = sanitizeCheckinPrefs(prefs);
  const saved = await apiCall<unknown>(getToken, BUILD_CHECKIN_PREFS_PATH, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return saved && typeof saved === "object" ? sanitizeCheckinPrefs(saved) : body;
}

/**
 * Exactly the three booleans; anything missing or malformed is `false`,
 * matching the server's default.
 *
 * Example: `sanitizeCheckinPrefs({ enabled: false })` →
 * `{ enabled: false, askAtLoading: false, askAfterGame: false }`.
 */
export function sanitizeCheckinPrefs(raw: unknown): BuildCheckinPrefs {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: source.enabled === true,
    askAtLoading: source.askAtLoading === true,
    askAfterGame: source.askAfterGame === true,
  };
}

/* ------------------------------------------------------------------
 * Error copy
 * ------------------------------------------------------------------ */

const ERROR_COPY: Record<string, string> = {
  not_eligible:
    "This game can't take a check-in. Only 1v1 games of 45 seconds or more with a known matchup count.",
  unknown_build:
    "That build isn't available for this matchup any more. Pick another one.",
  unknown_opponent_build:
    "That opponent build isn't available for this matchup any more. Pick another one.",
  slug_taken: "You already have a build called that — pick another name",
  already_bound:
    "That game has already been uploaded. Set its build from the game page instead.",
  invalid_notes: `Notes can be at most ${BUILD_INTENT_NOTES_MAX_LENGTH.toLocaleString("en-US")} characters.`,
  invalid_action: "That change isn't supported. Refresh the page and try again.",
  invalid_matchup: "That matchup isn't valid.",
  matchup_unknown: "The matchup isn't known yet, so no build can be matched.",
  declare_window_closed:
    "The game is already underway. Set the build once it ends.",
  not_found: "This game isn't in your synced history any more.",
  rate_limited: "Too many check-in changes at once. Wait a moment and try again.",
};

const NETWORK_COPY =
  "The API is unavailable or your connection was interrupted. Try again in a moment.";

/**
 * Friendly copy for a failed check-in request. Known API codes get
 * check-in specific wording; anything else keeps the humanised message
 * from `clientApi`.
 */
export function buildIntentErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const apiError = error as ClientApiError;
    if (apiError.code && ERROR_COPY[apiError.code]) return ERROR_COPY[apiError.code];
    if (apiError.status === 0) return apiError.message || NETWORK_COPY;
    if (apiError.message) return apiError.message;
  }
  if (error instanceof Error && error.name !== "AbortError") return NETWORK_COPY;
  return "Something went wrong. Try again in a moment.";
}

/** The API error code, when the failure carries one. */
export function buildIntentErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as ClientApiError).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/* ------------------------------------------------------------------
 * Display helpers
 * ------------------------------------------------------------------ */

export const INELIGIBLE_REASON_COPY: Record<IneligibleReason, string> = {
  resumed: "Replay-resume games are left out of every stat, so they can't be checked in.",
  not_1v1: "Check-ins are for 1v1 games only.",
  no_matchup: "This replay has no known matchup, so there's no build list to match against.",
  too_short: "Games under 45 seconds never count toward a build.",
};

export const STATUS_LABEL: Record<BuildIntentStatus, string> = {
  none: "Not checked in",
  pending: "Needs check-in",
  confirmed: "Checked in",
  skipped: "No set build",
};

/**
 * Short chip text that says why a build was suggested.
 *
 * Example: a `rules` suggestion with 4 of 5 rules passed → "4/5 rules matched".
 */
export function suggestionReasonLabel(
  suggestion: Pick<BuildSuggestion, "reason" | "passedRules" | "ruleCount">,
  matchup?: string | null,
): string {
  switch (suggestion.reason) {
    case "declared":
      return "Your pre-game pick";
    case "randomizer":
      return "Randomizer roll";
    case "detected":
      return "Detected in the replay";
    case "rules": {
      const { passedRules, ruleCount } = suggestion;
      return passedRules != null && ruleCount
        ? `${passedRules}/${ruleCount} rules matched`
        : "Closest rule match";
    }
    case "usual":
      return matchup ? `Your usual ${matchup} build` : "Your usual build";
    default:
      return "Suggested";
  }
}

/** Decided games only: ties and unknown results never enter the rate. */
export function winRate(wins: number, losses: number): number | null {
  const decided = Math.max(0, wins || 0) + Math.max(0, losses || 0);
  return decided > 0 ? Math.max(0, wins || 0) / decided : null;
}

/** Example: `recordText(7, 5)` → "7–5". */
export function recordText(wins: number, losses: number): string {
  return `${Math.max(0, wins || 0)}–${Math.max(0, losses || 0)}`;
}

/** Example: `winRateText(7, 5)` → "58%"; no decided games → null. */
export function winRateText(wins: number, losses: number): string | null {
  const rate = winRate(wins, losses);
  return rate == null ? null : `${Math.round(rate * 100)}%`;
}

/** Example: `checkinsText(3)` → "incl. 3 check-ins"; 0 or missing → null. */
export function checkinsText(count: number | null | undefined): string | null {
  if (!count || !Number.isFinite(count) || count <= 0) return null;
  return count === 1 ? "incl. 1 check-in" : `incl. ${Math.round(count)} check-ins`;
}

/** Tooltip copy for a "Planned" marker. */
export function plannedTooltip(detected: string | null | undefined): string {
  const label = (detected || "").trim();
  return label
    ? `Replay classified as ${label}`
    : "Counted from your check-in; the replay had no build label";
}

/**
 * The label a game's own stats use, plus the "Planned" marker data when a
 * confirmed check-in overrides the classifier. Without a check-in state the
 * fallback label (the slim row's `myBuild`) is returned unchanged.
 */
export function effectiveBuild(
  state: Pick<GameIntentState, "status" | "applied" | "build" | "detected"> | null | undefined,
  fallback: string | null | undefined,
): { label: string | null; planned: { detected: string | null } | null } {
  if (!state) return { label: fallback ?? null, planned: null };
  if (state.status === "confirmed" && state.applied && state.build) {
    return {
      label: state.build.name,
      planned: { detected: state.detected?.name ?? null },
    };
  }
  return { label: state.detected?.name ?? fallback ?? null, planned: null };
}

/**
 * Fold a PUT response into the loaded state: write responses carry no
 * build lists, so the loaded ones (both sides) are kept.
 */
export function mergeIntentUpdate(
  current: GameIntentState | undefined,
  next: GameIntentState,
): GameIntentState {
  const opponent =
    next.opponent === undefined
      ? current?.opponent
      : next.opponent && next.opponent.options === undefined && current?.opponent?.options
        ? { ...next.opponent, options: current.opponent.options }
        : next.opponent;
  return {
    ...next,
    options: next.options ?? current?.options,
    usualKey: next.usualKey ?? current?.usualKey ?? null,
    ...(opponent === undefined ? {} : { opponent }),
  };
}

/**
 * Split options into the "Your builds" and "All builds" groups, keeping
 * the server's order and dropping options that don't match `query`.
 */
export function groupBuildOptions(
  options: readonly BuildOption[],
  query = "",
): { yours: BuildOption[]; all: BuildOption[] } {
  const needle = query.trim().toLowerCase();
  const yours: BuildOption[] = [];
  const all: BuildOption[] = [];
  for (const option of options) {
    if (needle && !option.name.toLowerCase().includes(needle)) continue;
    (option.group === "yours" ? yours : all).push(option);
  }
  return { yours, all };
}

/** "PvZ"-style matchup from race names or letters; null when unknown. */
export function matchupFromRaces(
  myRace: string | null | undefined,
  oppRace: string | null | undefined,
): string | null {
  const mine = (myRace || "").trim().charAt(0).toUpperCase();
  const theirs = (oppRace || "").trim().charAt(0).toUpperCase();
  const matchup = `${mine}v${theirs}`;
  return MATCHUP_RE.test(matchup) ? matchup : null;
}

/**
 * The opponent's build as the game's own stats see it, plus the
 * "Corrected" marker data while a check-in overrides the classifier.
 * Without an opponent state the fallback (the slim row's strategy) is
 * returned unchanged.
 */
export function effectiveOpponentBuild(
  opponent: Pick<OpponentIntentState, "label" | "applied" | "build" | "detected"> | null | undefined,
  fallback: string | null | undefined,
): { label: string | null; corrected: { detected: string | null } | null } {
  if (!opponent) return { label: fallback ?? null, corrected: null };
  if (opponent.applied && opponent.build) {
    return {
      label: opponent.build.name,
      corrected: { detected: opponent.detected?.name ?? null },
    };
  }
  return {
    label: opponent.label ?? opponent.detected?.name ?? fallback ?? null,
    corrected: null,
  };
}

/**
 * The option key the opponent row starts on: the correction while one is
 * applied, otherwise the replay's own label when it is a pickable option.
 */
export function opponentCurrentKey(
  opponent: Pick<OpponentIntentState, "applied" | "build" | "detected"> | null | undefined,
): string | null {
  if (!opponent) return null;
  if (opponent.applied && opponent.build) return opponent.build.key;
  return opponent.detected?.key ?? null;
}

/* ------------------------------------------------------------------
 * "Add new build" from a check-in
 * ------------------------------------------------------------------ */

export const NEW_BUILD_CHECKED_IN = "Saved to your library and checked in";
export const NEW_BUILD_NOT_CHECKED_IN =
  "Saved to your library, but this game can't take it as its check-in";
export const NEW_BUILD_CHECKIN_FAILED =
  "Saved to your library, but the check-in didn't go through";

/**
 * The editor's starting name when the player didn't type one: the
 * matchup for your own builds ("PvZ — New build") and the opponent's
 * race for theirs ("Zerg build vs Protoss").
 */
export function defaultNewBuildName(
  side: CheckInSide,
  myRace: string | null | undefined,
  oppRace: string | null | undefined,
): string {
  const mine = raceWord(myRace);
  const theirs = raceWord(oppRace);
  if (side === "opponent") {
    if (theirs && mine) return `${theirs} build vs ${mine}`;
    return theirs ? `${theirs} build` : "Opponent build";
  }
  const matchup = matchupFromRaces(myRace, oppRace);
  return matchup ? `${matchup} — New build` : "New build";
}

/**
 * Copy for a just-saved build that didn't become the game's check-in:
 * either the game can't take it (wrong matchup, ineligible game) or the
 * write itself failed (network, rate limit) and can be retried.
 *
 * Example: `newBuildCheckinFailure("unknown_build", "…")` →
 * `{ title: NEW_BUILD_NOT_CHECKED_IN, reason: "It doesn't fit this game's matchup." }`.
 */
export function newBuildCheckinFailure(
  code: string | null,
  fallback: string,
  ineligibleReason?: IneligibleReason | null,
): { title: string; reason: string } {
  switch (code) {
    case "unknown_build":
    case "unknown_opponent_build":
      return { title: NEW_BUILD_NOT_CHECKED_IN, reason: "It doesn't fit this game's matchup." };
    case "not_eligible":
      return {
        title: NEW_BUILD_NOT_CHECKED_IN,
        reason: ineligibleReason ? INELIGIBLE_REASON_COPY[ineligibleReason] : ERROR_COPY.not_eligible,
      };
    default:
      return { title: NEW_BUILD_CHECKIN_FAILED, reason: fallback };
  }
}

function raceWord(race: string | null | undefined): string | null {
  switch ((race || "").trim().charAt(0).toUpperCase()) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    default:
      return null;
  }
}
