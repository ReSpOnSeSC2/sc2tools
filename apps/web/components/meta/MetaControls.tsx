"use client";

/**
 * Opponent-band axis, band, and matchup pickers for Ladder Meta Radar.
 *
 * Each change navigates to the canonical axis/band URL so every view is its
 * own crawlable, shareable URL and the server
 * component re-fetches + re-renders. No client-side data fetching — the
 * page is public and its API is fetched server-side (see app/meta/page.tsx),
 * and the authed useApi() hook would never fire for a signed-out visitor.
 */

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import {
  LEAGUES,
  MATCHUPS,
  MMR_BANDS,
  metaHref,
  parseBand,
  type BandAxis,
  type PatchEra,
} from "@/lib/meta";

export function MetaControls({
  axis,
  band,
  matchup,
  era,
}: {
  axis: BandAxis;
  band: number;
  matchup: string;
  era: PatchEra;
}) {
  const router = useRouter();

  function go(
    nextAxis: BandAxis,
    nextBand: number,
    nextMatchup: string,
    nextEra: PatchEra = era,
  ) {
    router.push(metaHref(nextAxis, nextBand, nextMatchup, nextEra));
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Game version
        </span>
        <span className="w-56">
          <Select
            aria-label="Game version"
            value={era}
            onChange={(event) =>
              go(axis, band, matchup, event.target.value as PatchEra)
            }
          >
            <option value="after">After 5.0.16 · 8 workers</option>
            <option value="before">Before 5.0.16 · 12 workers</option>
          </Select>
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Filter by
        </span>
        <span className="w-32">
          <Select
            aria-label="Band axis"
            value={axis}
            onChange={(event) => {
              const nextAxis = event.target.value as BandAxis;
              go(nextAxis, parseBand(nextAxis, undefined), matchup);
            }}
          >
            <option value="league">League</option>
            <option value="mmr">MMR</option>
          </Select>
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          {axis === "league" ? "League" : "Opponent MMR"}
        </span>
        <span className={axis === "league" ? "w-40" : "w-44"}>
          <Select
            aria-label={
              axis === "league" ? "League band" : "Opponent MMR band"
            }
            value={band}
            onChange={(event) =>
              go(axis, Number(event.target.value), matchup)
            }
          >
            {axis === "league"
              ? LEAGUES.map((league) => (
                  <option key={league.id} value={league.id}>
                    {league.label}
                  </option>
                ))
              : MMR_BANDS.map((mmrBand) => (
                  <option key={mmrBand.key} value={mmrBand.key}>
                    {mmrBand.label}
                  </option>
                ))}
          </Select>
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Matchup
        </span>
        <span className="w-28">
          <Select
            aria-label="Matchup"
            value={matchup}
            onChange={(event) => go(axis, band, event.target.value)}
          >
            {MATCHUPS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </span>
      </label>
    </div>
  );
}
