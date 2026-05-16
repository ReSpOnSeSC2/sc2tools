// Pure helpers shared by Stock Market + Builds-as-Cards.
//
// Build universe = the user's own played builds (from /v1/builds) PLUS
// every community build returned by /v1/community/builds PLUS every
// custom build the user has authored PLUS every entry from the bundled
// BUILD_DEFINITIONS catalog (the same 101 strategy definitions surfaced
// on /definitions). We deliberately do NOT filter community builds or
// catalog entries down to "ones the user has already played" — for a
// Protoss main, that filter collapsed the universe to Protoss-only,
// even though Stock Market is meant to be a speculation surface across
// every matchup. Untraded builds (no recent plays) still surface in
// the universe; the Stock Market UI labels them "no price yet" and
// disables their allocation input.
//
// The catalog source guarantees Z/T coverage even when the user
// hasn't played those matchups and the community has zero published
// builds for them — every analyzer-detectable strategy is a betting
// option.

import { BUILD_DEFINITIONS, type BuildDefinition } from "@/lib/build-definitions";
import { coerceRace, inferRaceFromBuildName, type Race } from "@/lib/race";
import type { ArcadeBuild, ArcadeDataset } from "./types";

/**
 * name → owning race lookup, precomputed from the bundled catalog so
 * `/v1/builds` rows (which never carry race — see
 * apps/api/src/services/builds.js, where the aggregation only projects
 * name/wins/losses/total) can inherit the canonical race when their
 * name matches a catalog entry.
 */
const CATALOG_RACE_BY_NAME: ReadonlyMap<string, string> = new Map(
  BUILD_DEFINITIONS.filter((d) => d.name && d.race).map((d) => [d.name, d.race]),
);

/**
 * Best-effort race assignment for a universe row. Trusts the source
 * field when present, then falls back to the catalog lookup, then to
 * structural inference off the build name (PvX → Protoss, etc.).
 * Returns undefined only when every signal fails, in which case the
 * card renders as Random.
 */
function resolveRace(name: string, supplied: string | undefined): string | undefined {
  if (typeof supplied === "string" && supplied.trim()) return supplied;
  const fromCatalog = CATALOG_RACE_BY_NAME.get(name);
  if (fromCatalog) return fromCatalog;
  return inferRaceFromBuildName(name) ?? undefined;
}

export interface UnifiedBuild {
  /** Stable id used in the portfolio + leaderboard JSON. */
  id: string;
  name: string;
  race?: string;
  totalPlays: number;
  wins: number;
  losses: number;
  winRate: number;
  /**
   * Provenance of the build entry:
   *   own       — user has played it (from /v1/builds)
   *   community — published community build (/v1/community/arcade-universe)
   *   custom    — user-authored private build (/v1/custom-builds)
   *   catalog   — bundled BUILD_DEFINITIONS strategy definition
   */
  source: "own" | "community" | "custom" | "catalog";
}

/**
 * "Unclassified - <Race>" is a sentinel name the Python build detector
 * emits when no signature in the registry matches the replay — it's a
 * placeholder, not a real build. We drop it from every Arcade surface
 * (Stock Market universe, Builds-as-Cards) so users don't see
 * "Unclassified - Protoss" / "Unclassified - Zerg" rows pretending to
 * be tradeable assets. Partial classifications like
 * "PvT - Macro Transition (Unclassified)" still carry matchup info
 * and ARE kept — only the bare race-level fallback is suppressed.
 *
 * See SC2Replay-Analyzer/detectors/user.py — the only emitter.
 */
export function isUnclassifiedSentinel(name: string): boolean {
  return /^Unclassified\s*-\s*/i.test(name);
}

/**
 * Build the universe of builds for an Arcade surface.
 *
 * `opts.includeCatalog` (default true) controls whether the bundled
 * BUILD_DEFINITIONS catalog seeds the universe. Stock Market wants
 * this on so the bet surface spans the full meta even when the user
 * has no Z/T plays. Builds-as-Cards also wants it on, but pairs it
 * with a `catalogFilter` so the binder is restricted to labels the
 * user-side detector could plausibly emit.
 *
 * `opts.catalogFilter`, when supplied, narrows the catalog rows that
 * get folded in. Builds-as-Cards uses this to drop opponent-only
 * labels (the `Protoss - X` / `Terran - X` / `Zerg - X` race-prefixed
 * rows in BUILD_DEFINITIONS are emitted by the OPPONENT detector
 * only — the user-side detector never tags myBuild with them, so
 * leaving them in the binder produces forever-locked stubs). When
 * omitted, every catalog row enters the universe (Stock Market's
 * "speculation across all matchups" behaviour).
 */
export function buildUniverse(
  data: ArcadeDataset,
  opts: {
    includeCatalog?: boolean;
    catalogFilter?: (def: BuildDefinition) => boolean;
  } = {},
): UnifiedBuild[] {
  const includeCatalog = opts.includeCatalog !== false;
  const byName = new Map<string, UnifiedBuild>();
  for (const b of data.builds) {
    if (!b.name) continue;
    if (isUnclassifiedSentinel(b.name)) continue;
    byName.set(b.name, {
      id: `own:${b.name}`,
      name: b.name,
      race: resolveRace(b.name, b.race),
      totalPlays: b.total,
      wins: b.wins,
      losses: b.losses,
      winRate: b.winRate,
      source: "own",
    });
  }
  // Community additions: every community build enters the universe so
  // the Stock Market shows builds across all matchups, not just the
  // ones the user has already played. The Stock Market UI handles the
  // "no recent plays" case by disabling allocation for those rows
  // (rolling14DayWr returns null when there are fewer than 3 plays in
  // the 14-day window).
  for (const c of data.communityBuilds) {
    if (!c.title || isUnclassifiedSentinel(c.title)) continue;
    const own = byName.get(c.title);
    if (own) continue; // already in universe via /v1/builds
    byName.set(c.title, {
      id: `community:${c.slug}`,
      name: c.title,
      race: resolveRace(c.title, c.race),
      totalPlays: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      source: "community",
    });
  }
  // Custom builds: every build the user has AUTHORED enters the
  // universe — even at zero plays. Untradeable until they accumulate
  // ≥3 plays in the rolling 14-day window (rolling14DayWr returns
  // null below that floor), which the Stock Market UI surfaces as
  // a missing price.
  for (const cb of data.customBuilds) {
    if (!cb.name || isUnclassifiedSentinel(cb.name)) continue;
    const own = byName.get(cb.name);
    if (own) continue;
    byName.set(cb.name, {
      id: `custom:${cb.slug}`,
      name: cb.name,
      race: resolveRace(cb.name, cb.race),
      totalPlays: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      source: "custom",
    });
  }
  // Bundled catalog (BUILD_DEFINITIONS): every analyzer-detectable
  // strategy enters the universe regardless of whether the user has
  // played it, the community has published it, or the user has
  // authored a custom variant. This is the only path that guarantees
  // Z/T coverage for a Protoss main with no Z/T plays and a
  // Protoss-heavy community feed. Catalog entries with a name that
  // collides with own/community/custom inherit that source's price;
  // de-novo catalog rows surface as "no price yet" (untradeable)
  // until plays accumulate.
  if (includeCatalog) {
    const filter = opts.catalogFilter;
    for (const def of BUILD_DEFINITIONS) {
      if (!def.name || isUnclassifiedSentinel(def.name)) continue;
      if (byName.has(def.name)) continue;
      if (filter && !filter(def)) continue;
      byName.set(def.name, {
        id: `catalog:${def.id}`,
        name: def.name,
        race: def.race,
        totalPlays: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        source: "catalog",
      });
    }
  }
  return Array.from(byName.values());
}

/**
 * The set of player races the user has actually piloted, derived from
 * the `myRace` field on their recorded games. Single-race mains
 * collapse to `new Set(["Protoss"])`; off-race dabblers add a second
 * entry. Falls back to inferring from build-name prefixes on
 * `data.builds` when game-level `myRace` is missing (legacy rows from
 * ingestion paths that didn't project it).
 */
export function userPlayedRaces(data: ArcadeDataset): Set<Race> {
  const races = new Set<Race>();
  for (const g of data.games) {
    const r = coerceRace(g.myRace, "Random");
    if (r !== "Random") races.add(r);
  }
  if (races.size > 0) return races;
  // Fallback: infer from build prefixes when games[].myRace was empty.
  // Heavy users with legacy ingestion data sometimes have games rows
  // missing myRace; the build name still carries the matchup prefix
  // (e.g. "PvT - Phoenix into Robo"), which pins the user's race.
  for (const b of data.builds) {
    if (!b.name) continue;
    const r = inferRaceFromBuildName(b.name);
    if (r && r !== "Random") races.add(r);
  }
  return races;
}

/**
 * Predicate for `buildUniverse({ catalogFilter })` that keeps only
 * catalog rows the analyzer's USER-side detector can plausibly emit
 * as a player's `myBuild`. Concretely:
 *
 *   • The row must be matchup-prefixed (PvP-X / PvT-X / PvZ-X / TvP-X
 *     / TvT-X / TvZ-X / ZvP-X / ZvT-X / ZvZ-X). The race-prefixed
 *     rows (`Protoss - 4 Gate Rush`, `Terran - 1-1-1 Standard`,
 *     `Zerg - 12 Pool`) are emitted by the OPPONENT detector only —
 *     the user-side classifier never tags myBuild with them.
 *   • The row's owning race must be one the user has actually played.
 *     A Protoss main never gets a TvP / ZvT myBuild, so those rows
 *     would still surface as forever-locked stubs in their binder.
 *
 * Returns false on every row when the user race set is empty
 * (brand-new account with no games). The binder's empty-state
 * message ("Play a few games and we'll start unlocking your card
 * binder.") takes over for fresh accounts.
 */
export function userEmittableCatalogEntry(
  def: BuildDefinition,
  userRaces: ReadonlySet<Race>,
): boolean {
  if (def.matchup === null) return false;
  if (userRaces.size === 0) return false;
  return userRaces.has(def.race);
}

/**
 * Rolling-14-day WR for a given build name, computed from the user's
 * games. Returns null if the build has fewer than 3 plays in the window
 * — those builds are excluded from Stock Market price quotes.
 *
 * Matchup-agnostic builds (custom builds with `vsRace === "X"`) match
 * games against any opponent race, since the user's authored build
 * doesn't restrict which matchup it should be priced over.
 */
export function rolling14DayWr(
  name: string,
  data: ArcadeDataset,
  now: Date,
): number | null {
  const cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  let wins = 0;
  let losses = 0;
  for (const g of data.games) {
    if ((g.myBuild || "") !== name) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const r = String(g.result || "").toLowerCase();
    if (r === "win" || r === "victory") wins += 1;
    else if (r === "loss" || r === "defeat") losses += 1;
  }
  if (wins + losses < 3) return null;
  return wins / (wins + losses);
}

/**
 * Card rarity tier from total plays.
 * bronze: 1–4, silver: 5–14, gold: 15–49, mythic: 50+.
 */
export function rarityForPlays(plays: number): "bronze" | "silver" | "gold" | "mythic" {
  if (plays >= 50) return "mythic";
  if (plays >= 15) return "gold";
  if (plays >= 5) return "silver";
  return "bronze";
}

export function attackForBuild(b: ArcadeBuild | UnifiedBuild): number {
  return Math.max(0, Math.min(100, Math.round((b.winRate || 0) * 100)));
}

/** Defense = mean win-length minutes, clamped 1..60. */
export function defenseFor(buildName: string, data: ArcadeDataset): number {
  let sum = 0;
  let count = 0;
  for (const g of data.games) {
    if ((g.myBuild || "") !== buildName) continue;
    const r = String(g.result || "").toLowerCase();
    if (r !== "win" && r !== "victory") continue;
    const dur = Number(g.duration);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    sum += dur;
    count += 1;
  }
  if (count === 0) return 1;
  return Math.max(1, Math.min(60, Math.round(sum / count / 60)));
}

/** Foil if the user has ≥10 wins with this build. */
export function isFoil(buildName: string, data: ArcadeDataset): boolean {
  const own = data.builds.find((b) => b.name === buildName);
  return !!own && own.wins >= 10;
}
