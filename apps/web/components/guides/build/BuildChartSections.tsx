import { Section } from "@/components/ui/Section";
import { LazyCiBarChart } from "@/components/guides/LazyCiBarChart";
import type { CiBarDatum } from "@/components/guides/CiBarChart";
import type { GuideBandCell, GuideBandCells, GuideLengthRow } from "@/lib/guides/types";

/**
 * Chart sections of a build guide — 2: win rate by opponent league and
 * MMR band; 6: win rate by game length. Each renders only the cells the
 * API published (every one already met the floor) and hides itself when
 * there are none.
 */

const SECONDS_PER_MINUTE = 60;

function bandData(cells: ReadonlyArray<GuideBandCell>, axis: "league" | "mmr"): CiBarDatum[] {
  return cells.map((cell) => ({
    key: `${axis}-${cell.value}`,
    label: axis === "mmr" ? `${cell.label} MMR` : cell.label,
    winRate: cell.winRate,
    ci: cell.ci,
    games: cell.games,
    users: cell.users,
  }));
}

export function BuildBandsSection({ bands }: { bands: GuideBandCells }) {
  const league = bandData(bands.league, "league");
  const mmr = bandData(bands.mmr, "mmr");
  if (league.length === 0 && mmr.length === 0) return null;
  return (
    <Section
      id="win-rate-by-band"
      title="Win rate by league and MMR"
      description="Grouped by the opponent's league and MMR band. Bands without enough games are left out."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {league.length > 0 ? (
          <div className="min-w-0 space-y-2">
            <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              By opponent league
            </h3>
            <LazyCiBarChart title="Win rate by opponent league" data={league} />
          </div>
        ) : null}
        {mmr.length > 0 ? (
          <div className="min-w-0 space-y-2">
            <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              By opponent MMR
            </h3>
            <LazyCiBarChart title="Win rate by opponent MMR band" data={mmr} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Bucket label in minutes.
 *
 * Example: `lengthLabel({ minSec: 360, maxSec: 600 })` → "6–10 min";
 * `{ minSec: 1200, maxSec: null }` → "20+ min".
 */
export function lengthLabel(row: Pick<GuideLengthRow, "minSec" | "maxSec">): string {
  const from = Math.round(row.minSec / SECONDS_PER_MINUTE);
  if (row.maxSec === null) return `${from}+ min`;
  return `${from}–${Math.round(row.maxSec / SECONDS_PER_MINUTE)} min`;
}

export function BuildLengthsSection({ lengths }: { lengths: ReadonlyArray<GuideLengthRow> }) {
  if (lengths.length === 0) return null;
  const data: CiBarDatum[] = [...lengths]
    .sort((a, b) => a.minSec - b.minSec)
    .map((row) => ({
      key: row.bucket,
      label: lengthLabel(row),
      winRate: row.winRate,
      ci: row.ci,
      games: row.games,
      users: row.users,
    }));
  return (
    <Section
      id="when-it-wins"
      title="When it wins"
      description="Win rate by game length: does the build close games early or pay off late?"
    >
      <LazyCiBarChart title="Win rate by game length" data={data} />
    </Section>
  );
}
