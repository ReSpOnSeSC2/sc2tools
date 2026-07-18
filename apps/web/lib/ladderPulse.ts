import {
  MMR_BANDS,
  type BandAxis,
  type MetaOpener,
  type MetaRow,
  type PatchEra,
} from "@/lib/meta";
import { PATCH_5_0_16_RELEASE } from "@/lib/datePresets";

const DAY_MS = 86_400_000;
export const FRESH_REPLAY_MAX_AGE_MS = 30 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PATCH_5_0_16_BUILD = 97_364;

export type PulseResult = "win" | "loss" | "tie" | "unknown";

export interface PulseLeak {
  name?: string | null;
  detail?: string | null;
  quantity?: number | null;
  mineral_cost?: number | null;
  penalty?: number | null;
}

export interface PulseOpponent {
  pulseId?: string | null;
  displayName?: string | null;
  race?: string | null;
  mmr?: number | null;
  leagueId?: number | null;
  strategy?: string | null;
}

/**
 * Slim replay row returned by GET /v1/games.
 *
 * The feed deliberately reads only fields retained on the indexed games
 * document. Heavy build logs and macro timelines remain in game_details and
 * are loaded only after the user opens the full replay analysis.
 */
export interface PulseGame {
  gameId: string;
  date?: string | null;
  result?: string | null;
  map?: string | null;
  playerCount?: number | null;
  isLadderGame?: boolean | null;
  gameVersion?: string | null;
  gameBuild?: number | null;
  myRace?: string | null;
  myLadderRace?: string | null;
  myToonHandle?: string | null;
  myBuild?: string | null;
  myMmr?: number | null;
  myMmrSource?: string | null;
  durationSec?: number | null;
  macroScore?: number | null;
  top3Leaks?: PulseLeak[] | null;
  opponent?: PulseOpponent | null;
}

export interface PulseGamesPage {
  items?: PulseGame[] | null;
  nextBefore?: string | null;
}

export interface VerifiedMmrDelta {
  from: number;
  to: number;
  delta: number;
  previousGameId: string;
}

export interface PulseRecord {
  wins: number;
  losses: number;
  ties: number;
  total: number;
}

export type PersonalForm =
  | (PulseRecord & {
      kind: "build";
      label: string;
      windowGames: number;
    })
  | (PulseRecord & {
      kind: "matchup";
      label: string;
      windowGames: number;
    })
  | (PulseRecord & {
      kind: "recent";
      label: string;
      windowGames: number;
    });

export interface MetaSelection {
  axis: BandAxis;
  band: number;
  matchup: string;
  era: PatchEra;
}

export interface MetaMover {
  kind: "new" | "rising" | "top";
  opener: MetaOpener;
}

/**
 * Defensive newest-first ordering for a wire page. Invalid dates are not
 * useful in a freshness surface and are omitted instead of being presented
 * as "just now".
 */
export function sortPulseGames(
  rows: ReadonlyArray<PulseGame> | null | undefined,
): PulseGame[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (game) =>
        !!game &&
        typeof game.gameId === "string" &&
        game.gameId.trim().length > 0 &&
        finiteTimestamp(game.date) !== null,
    )
    .slice()
    .sort(
      (a, b) =>
        (finiteTimestamp(b.date) ?? 0) - (finiteTimestamp(a.date) ?? 0),
    );
}

export function pulseResult(value: unknown): PulseResult {
  if (typeof value !== "string") return "unknown";
  const result = value.trim().toLowerCase();
  if (result === "victory" || result === "win") return "win";
  if (result === "defeat" || result === "loss") return "loss";
  if (result === "tie" || result === "draw") return "tie";
  return "unknown";
}

/** Concrete replay matchup, e.g. Protoss vs Zerg -> PvZ. */
export function pulseMatchup(game: PulseGame | null | undefined): string | null {
  const mine = raceLetter(game?.myRace);
  const theirs = raceLetter(game?.opponent?.race);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

/**
 * Compare replay-authored MMR only when both rows belong to the same toon and
 * selected ladder race. This avoids fake jumps caused by switching regions,
 * accounts, or Random/one-race queues.
 */
export function verifiedMmrDelta(
  rows: ReadonlyArray<PulseGame> | null | undefined,
): VerifiedMmrDelta | null {
  const games = sortPulseGames(rows);
  const latest = games[0];
  if (!isVerifiedMmrGame(latest)) return null;

  const toon = latest.myToonHandle!.trim();
  const ladderRace = queueRace(latest);
  if (!ladderRace) return null;

  const previous = games.slice(1).find((game) => {
    if (!isVerifiedMmrGame(game)) return false;
    return (
      game.myToonHandle!.trim() === toon &&
      queueRace(game) === ladderRace
    );
  });
  if (!previous) return null;

  const from = Math.round(previous.myMmr!);
  const to = Math.round(latest.myMmr!);
  return {
    from,
    to,
    delta: to - from,
    previousGameId: previous.gameId,
  };
}

/**
 * "New replay" is intentionally tied to the replay's end timestamp, not the
 * Socket.io notification. Historical imports emit games:changed too; the
 * thirty-minute gate prevents those batches from impersonating a live result.
 */
export function isFreshReplay(
  game: PulseGame | null | undefined,
  nowMs: number = Date.now(),
  maxAgeMs: number = FRESH_REPLAY_MAX_AGE_MS,
): boolean {
  const playedAt = finiteTimestamp(game?.date);
  if (playedAt === null || !Number.isFinite(nowMs)) return false;
  const age = nowMs - playedAt;
  return age >= -FUTURE_CLOCK_SKEW_MS && age <= maxAgeMs;
}

/**
 * Stable per-user daily replay. With a stable candidate list and at least two
 * rows, advancing one local date advances one slot rather than relying on a
 * random draw that could repeat yesterday.
 */
export function pickDailyReplay(
  rows: ReadonlyArray<PulseGame> | null | undefined,
  userId: string,
  dayKey: string,
  excludeGameId?: string | null,
): PulseGame | null {
  const sorted = sortPulseGames(rows);
  if (sorted.length === 0) return null;

  const withoutLatest = sorted.filter(
    (game) => !excludeGameId || game.gameId !== excludeGameId,
  );
  const pool = withoutLatest.length > 0 ? withoutLatest : sorted;
  const substantial = pool.filter(
    (game) =>
      pulseResult(game.result) !== "unknown" &&
      (game.durationSec == null ||
        (Number.isFinite(game.durationSec) && game.durationSec >= 60)),
  );
  const candidates = substantial.length > 0 ? substantial : pool;
  const ordinal = dayOrdinal(dayKey);
  const userOffset = stableHash(userId || "anonymous");
  return candidates[(ordinal + userOffset) % candidates.length] ?? null;
}

/** Last N decided games, newest first. Ties are retained and labelled. */
export function recentPulseRecord(
  rows: ReadonlyArray<PulseGame> | null | undefined,
  limit: number = 5,
): PulseRecord {
  const decided = sortPulseGames(rows)
    .map((game) => pulseResult(game.result))
    .filter((result) => result !== "unknown")
    .slice(0, Math.max(0, Math.floor(limit)));
  return recordFromResults(decided);
}

/**
 * Factual fallback for a sparse/unavailable corpus-meta row. Claims are
 * explicitly bounded to the loaded window; no lifetime language is used.
 */
export function personalFormForLatest(
  rows: ReadonlyArray<PulseGame> | null | undefined,
): PersonalForm | null {
  const games = sortPulseGames(rows);
  const latest = games[0];
  if (!latest) return null;
  const windowGames = games.length;

  const build = clean(latest.myBuild);
  if (build) {
    const results = games
      .filter((game) => clean(game.myBuild) === build)
      .map((game) => pulseResult(game.result))
      .filter((result) => result !== "unknown");
    if (results.length >= 3) {
      return {
        kind: "build",
        label: build,
        windowGames,
        ...recordFromResults(results),
      };
    }
  }

  const matchup = pulseMatchup(latest);
  if (matchup) {
    const results = games
      .filter((game) => pulseMatchup(game) === matchup)
      .map((game) => pulseResult(game.result))
      .filter((result) => result !== "unknown");
    if (results.length >= 3) {
      return {
        kind: "matchup",
        label: matchup,
        windowGames,
        ...recordFromResults(results),
      };
    }
  }

  const recent = games
    .map((game) => pulseResult(game.result))
    .filter((result) => result !== "unknown")
    .slice(0, 5);
  if (recent.length === 0) return null;
  return {
    kind: "recent",
    label: `Last ${recent.length}`,
    windowGames,
    ...recordFromResults(recent),
  };
}

/**
 * Select the live meta row closest to the latest replay. League is preferred
 * because it is available on more ingested games; opponent MMR maps to the
 * exact public 500-point bands as a fallback.
 */
export function metaSelectionForGame(
  game: PulseGame | null | undefined,
): MetaSelection | null {
  if (!game) return null;
  if (
    (typeof game.playerCount === "number" && game.playerCount !== 2) ||
    game.isLadderGame === false
  ) {
    return null;
  }
  const matchup = pulseMatchup(game);
  if (!matchup) return null;
  const era = patchEraForGame(game);

  const rawLeagueId = game.opponent?.leagueId;
  const leagueId =
    typeof rawLeagueId === "number" ? rawLeagueId : Number.NaN;
  if (Number.isInteger(leagueId) && leagueId >= 0 && leagueId <= 6) {
    return { axis: "league", band: leagueId, matchup, era };
  }

  const mmr = Number(game.opponent?.mmr);
  const band = mmrBandFor(mmr);
  return band === null
    ? null
    : { axis: "mmr", band, matchup, era };
}

/**
 * Match the API's patch-era precedence: exact numeric build, version-string
 * build, then replay time for legacy rows. A malformed legacy row defaults to
 * the live era rather than surfacing obsolete 12-worker guidance.
 */
export function patchEraForGame(
  game: PulseGame | null | undefined,
): PatchEra {
  const numericBuild =
    typeof game?.gameBuild === "number" &&
    Number.isInteger(game.gameBuild) &&
    game.gameBuild > 0
      ? game.gameBuild
      : null;
  const versionBuild =
    numericBuild === null ? buildFromVersion(game?.gameVersion) : null;
  const build = numericBuild ?? versionBuild;
  if (build !== null) {
    return build >= PATCH_5_0_16_BUILD ? "after" : "before";
  }

  const playedAt = finiteTimestamp(game?.date);
  return playedAt !== null &&
    playedAt < PATCH_5_0_16_RELEASE.getTime()
    ? "before"
    : "after";
}

export function metaApiPath(selection: MetaSelection | null): string | null {
  if (!selection) return null;
  const query = new URLSearchParams({
    axis: selection.axis,
    band: String(selection.band),
    matchup: selection.matchup,
    era: selection.era,
  });
  return `/v1/meta/ladder?${query.toString()}`;
}

export function mmrBandFor(raw: unknown): number | null {
  const mmr = Number(raw);
  if (!Number.isFinite(mmr) || mmr <= 0) return null;
  if (mmr < 2000) return 1000;
  if (mmr >= 6500) return 6500;
  const floor = Math.floor(mmr / 500) * 500;
  return MMR_BANDS.some((candidate) => candidate.key === floor)
    ? floor
    : null;
}

/**
 * Prefer genuinely new openers, then positive prevalence movement, then the
 * highest-volume real opener. Negative-only movement is not described as
 * "rising".
 */
export function pickMetaMover(row: MetaRow | null | undefined): MetaMover | null {
  const openers = Array.isArray(row?.openers)
    ? row!.openers.filter(
        (opener) =>
          !!opener &&
          typeof opener.build === "string" &&
          opener.build.trim().length > 0 &&
          Number.isFinite(opener.games) &&
          opener.games > 0,
      )
    : [];
  if (openers.length === 0) return null;

  const newlySurfaced = openers
    .filter((opener) => opener.isNew)
    .sort((a, b) => b.games - a.games)[0];
  if (newlySurfaced) return { kind: "new", opener: newlySurfaced };

  const rising = openers
    .filter(
      (opener) =>
        typeof opener.freqDelta === "number" && opener.freqDelta > 0,
    )
    .sort(
      (a, b) =>
        (b.freqDelta ?? 0) - (a.freqDelta ?? 0) || b.games - a.games,
    )[0];
  if (rising) return { kind: "rising", opener: rising };

  const top = openers.slice().sort((a, b) => b.games - a.games)[0];
  return top ? { kind: "top", opener: top } : null;
}

function isVerifiedMmrGame(
  game: PulseGame | null | undefined,
): game is PulseGame & {
  myMmr: number;
  myMmrSource: "replay";
  myToonHandle: string;
} {
  return (
    !!game &&
    (game.playerCount == null || game.playerCount === 2) &&
    game.isLadderGame !== false &&
    game.myMmrSource === "replay" &&
    typeof game.myMmr === "number" &&
    Number.isFinite(game.myMmr) &&
    game.myMmr > 0 &&
    typeof game.myToonHandle === "string" &&
    game.myToonHandle.trim().length > 0
  );
}

function buildFromVersion(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return null;
  }
  const build = Number(parts[parts.length - 1]);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

function queueRace(game: PulseGame): string | null {
  const raw = clean(game.myLadderRace) || clean(game.myRace);
  if (!raw) return null;
  const letter = raw.charAt(0).toUpperCase();
  return letter === "P" || letter === "T" || letter === "Z" || letter === "R"
    ? letter
    : null;
}

function raceLetter(value: unknown): "P" | "T" | "Z" | null {
  if (typeof value !== "string") return null;
  const letter = value.trim().charAt(0).toUpperCase();
  return letter === "P" || letter === "T" || letter === "Z"
    ? letter
    : null;
}

function recordFromResults(results: PulseResult[]): PulseRecord {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const result of results) {
    if (result === "win") wins += 1;
    else if (result === "loss") losses += 1;
    else if (result === "tie") ties += 1;
  }
  return { wins, losses, ties, total: wins + losses + ties };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof Date)
  ) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dayOrdinal(dayKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return 0;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isFinite(timestamp) ? Math.floor(timestamp / DAY_MS) : 0;
}

/** Small deterministic FNV-1a hash. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
