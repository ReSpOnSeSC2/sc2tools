// Pure helpers shared by Stock Market + Builds-as-Cards.
//
// Build universe = the user's own played builds (from /v1/builds) PLUS
// any community/custom build the user has actually played at least once
// (cross-referenced by name). This is the single source of truth so
// Stock Market price math and the Higher-or-Lower stack agree on what
// counts as "a build the user owns."

import type { ArcadeBuild, ArcadeDataset } from "./types";

export interface UnifiedBuild {
  /** Stable id used in the portfolio + leaderboard JSON. */
  id: string;
  name: string;
  race?: string;
  totalPlays: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Source: "own" if it lives in /v1/builds; "community" otherwise. */
  source: "own" | "community" | "custom";
}

export function buildUniverse(data: ArcadeDataset): UnifiedBuild[] {
  const byName = new Map<string, UnifiedBuild>();
  for (const b of data.builds) {
    if (!b.name) continue;
    byName.set(b.name, {
      id: `own:${b.name}`,
      name: b.name,
      race: b.race,
      totalPlays: b.total,
      wins: b.wins,
      losses: b.losses,
      winRate: b.winRate,
      source: "own",
    });
  }
  // Community + custom additions: only include when the user has played
  // a build with a matching title at least once. We dedupe by build name
  // to keep the universe focused.
  const playedNames = new Set(data.builds.map((b) => b.name.toLowerCase()));
  for (const c of data.communityBuilds) {
    const key = c.title.toLowerCase();
    if (!playedNames.has(key)) continue;
    const own = byName.get(c.title);
    if (own) continue; // already in universe via /v1/builds
    byName.set(c.title, {
      id: `community:${c.slug}`,
      name: c.title,
      race: c.race,
      totalPlays: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      source: "community",
    });
  }
  for (const cb of data.customBuilds) {
    const key = cb.name.toLowerCase();
    if (!playedNames.has(key)) continue;
    const own = byName.get(cb.name);
    if (own) continue;
    byName.set(cb.name, {
      id: `custom:${cb.slug}`,
      name: cb.name,
      race: cb.race,
      totalPlays: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      source: "custom",
    });
  }
  return Array.from(byName.values());
}

/**
 * Rolling-14-day WR for a given build name, computed from the user's
 * games. Returns null if the build has fewer than 3 plays in the window
 * — those builds are excluded from Stock Market price quotes.
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
