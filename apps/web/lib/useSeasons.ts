"use client";

// Authoritative SC2 ladder season catalog, fetched from /v1/seasons
// (which proxies SC2Pulse with caching). The endpoint is unauthed —
// the catalog is the same for every user — so we don't gate on the
// Clerk auth state.
//
// SC2Pulse returns one row per (battlenetId, region). We roll up by
// battlenetId because that's the global sequential season id the
// player community calls "Season N" — `number` resets within each
// `year`, so it is NOT a stable identifier for "Season 67".

import useSWR from "swr";
import { API_BASE } from "@/lib/clientApi";

export type SeasonRow = {
  battlenetId: number;
  region: string;
  year: number | null;
  number: number | null;
  start: string | null;
  end: string | null;
};

export type SeasonsApiResponse = {
  items: SeasonRow[];
  current: number | null;
  source: "pulse" | "fallback";
  fetchedAt: number | null;
};

/** Reduce per-region rows down to one row per global season. */
export type LogicalSeason = {
  /** The global ladder season number — what players call "Season N". */
  number: number;
  /** Same as `number`; kept for callers that prefer the battlenetId name. */
  battlenetId: number;
  /** Year this season belongs to (per Blizzard's annual reset). */
  year: number | null;
  /** Per-year sub-index from Blizzard (1..4 historically). */
  numberInYear: number | null;
  /** Earliest start across regions (ISO string) — null if missing. */
  start: string | null;
  /** Latest end across regions (ISO string) — null if missing. */
  end: string | null;
  /** True if this is the most-recent season in the catalog. */
  isCurrent: boolean;
};

const PATH = "/v1/seasons";

export function useSeasons() {
  return useSWR<SeasonsApiResponse>(
    PATH,
    async (path: string) => {
      const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    {
      // Catalog refreshes 4x/day on the server; client can be lazier.
      revalidateOnFocus: false,
      dedupingInterval: 60 * 60 * 1000,
    },
  );
}

/**
 * Roll the per-region catalog up to one row per global season,
 * sorted newest first. We group by `battlenetId` because that's the
 * stable global identifier — `number` resets per year and would
 * collide.
 */
export function rollUpSeasons(rows: SeasonRow[] | undefined): LogicalSeason[] {
  if (!rows || rows.length === 0) return [];
  const byId = new Map<number, LogicalSeason>();
  let maxBnid = -Infinity;
  for (const row of rows) {
    if (row.battlenetId > maxBnid) maxBnid = row.battlenetId;
  }
  for (const row of rows) {
    const id = row.battlenetId;
    if (!Number.isFinite(id)) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        number: id,
        battlenetId: id,
        year: row.year,
        numberInYear: row.number,
        start: row.start,
        end: row.end,
        isCurrent: id === maxBnid,
      });
      continue;
    }
    if (row.start && (!existing.start || row.start < existing.start)) {
      existing.start = row.start;
    }
    if (row.end && (!existing.end || row.end > existing.end)) {
      existing.end = row.end;
    }
    if (existing.year == null && row.year != null) existing.year = row.year;
    if (existing.numberInYear == null && row.number != null) {
      existing.numberInYear = row.number;
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.number - a.number);
}

/** Best-effort current-season number from the rolled-up catalog. */
export function currentSeasonNumber(seasons: LogicalSeason[]): number | null {
  const cur = seasons.find((s) => s.isCurrent);
  return cur ? cur.number : seasons[0]?.number || null;
}
