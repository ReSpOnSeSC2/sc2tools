"use client";

/**
 * League-band + matchup pickers for the public Ladder Meta Radar page.
 *
 * Each change navigates to ``/meta?league=<id>&matchup=<XvY>`` so every
 * (band, matchup) view is its own crawlable, shareable URL and the server
 * component re-fetches + re-renders. No client-side data fetching — the
 * page is public and its API is fetched server-side (see app/meta/page.tsx),
 * and the authed useApi() hook would never fire for a signed-out visitor.
 */

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { LEAGUES, MATCHUPS } from "@/lib/meta";

export function MetaControls({
  leagueId,
  matchup,
}: {
  leagueId: number;
  matchup: string;
}) {
  const router = useRouter();

  function go(nextLeague: number, nextMatchup: string) {
    router.push(`/meta?league=${nextLeague}&matchup=${nextMatchup}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          League
        </span>
        <span className="w-40">
          <Select
            aria-label="League band"
            value={leagueId}
            onChange={(e) => go(Number(e.target.value), matchup)}
          >
            {LEAGUES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
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
            onChange={(e) => go(leagueId, e.target.value)}
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
