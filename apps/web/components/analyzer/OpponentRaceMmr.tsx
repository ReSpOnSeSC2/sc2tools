"use client";

import { Icon } from "@/components/ui/Icon";
import { Card, Skeleton } from "@/components/ui/Card";
import { fmtMmr } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import type { GlobalPlayerIdentity } from "@/lib/opponentGroups";

export type PulseRaceRow = {
  race: string;
  mmr: number;
  games: number;
  league: string | null;
  region: string | null;
};

export type PulseRaceBreakdown = {
  resolved: boolean;
  races: PulseRaceRow[];
  topRace: string | null;
  topMmr: number | null;
  ladderIdentity?: {
    pulseCharacterId: string | null;
    toonHandle: string | null;
    displayName: string | null;
    region: string | null;
    confirmed: boolean;
  };
};

/** Ignore a cached account response while an approved target changes. */
function matchesConfirmedIdentity(
  breakdown: PulseRaceBreakdown | undefined,
  confirmedIdentity: GlobalPlayerIdentity | null | undefined,
): boolean {
  if (!confirmedIdentity) return true;
  const source = breakdown?.ladderIdentity;
  if (!source?.confirmed) return false;
  const target = confirmedIdentity.target;
  if (target.pulseCharacterId && source.pulseCharacterId !== target.pulseCharacterId) return false;
  if (target.toonHandle && source.toonHandle !== target.toonHandle) return false;
  return source.displayName === confirmedIdentity.displayName;
}

/**
 * Headline MMR for the opponent profile: their highest-rated race.
 * Returns null when there's no resolved breakdown so the caller can
 * fall back to the single stored MMR.
 */
export function topHeadlineMmr(
  b: PulseRaceBreakdown | undefined,
): { mmr: number; race: string } | null {
  if (!b || !b.resolved) return null;
  if (typeof b.topMmr === "number" && b.topRace) {
    return { mmr: b.topMmr, race: b.topRace };
  }
  return null;
}

/**
 * Last-known MMR pill for the opponent profile header. When the
 * per-race breakdown resolved, shows their highest-rated race's MMR,
 * tinted with that race. Otherwise falls back to the single stored
 * ``fallbackMmr`` (the most-recent-game value) so behaviour matches the
 * pre-breakdown UI when SC2Pulse is unreachable.
 */
export function HeadlineMmrChip({
  breakdown,
  fallbackMmr,
  confirmedIdentity,
}: {
  breakdown: PulseRaceBreakdown | undefined;
  fallbackMmr?: number | null;
  confirmedIdentity?: GlobalPlayerIdentity | null;
}) {
  if (!matchesConfirmedIdentity(breakdown, confirmedIdentity)) return null;
  const top = topHeadlineMmr(breakdown);
  if (top) {
    const race = coerceRace(top.race);
    const tint = raceTint(race);
    return (
      <span
        role="note"
        aria-label={`${race} MMR ${top.mmr}${breakdown?.ladderIdentity?.confirmed ? ` for ${breakdown.ladderIdentity.displayName}'s main profile` : ""}`}
        title={breakdown?.ladderIdentity?.confirmed
          ? `Highest-rated race on ${breakdown.ladderIdentity.displayName}'s confirmed main profile (SC2Pulse)`
          : "Highest-rated race on this account (SC2Pulse)"}
        className={`inline-flex items-center gap-1.5 rounded-full border ${tint.border} ${tint.bg} px-2 py-0.5 text-micro font-medium uppercase tracking-wider ${tint.text} tabular-nums`}
      >
        <Icon name={raceIconName(race)} kind="race" className="h-3.5 w-3.5" />
        <span>{fmtMmr(top.mmr)}</span>
      </span>
    );
  }
  if (!confirmedIdentity && !breakdown?.ladderIdentity?.confirmed && typeof fallbackMmr === "number" && fallbackMmr > 0) {
    return (
      <span
        role="note"
        aria-label={`Last known MMR ${Math.round(fallbackMmr)}`}
        title="Last known MMR — most recent game on record"
        className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-micro font-medium uppercase tracking-wider text-accent tabular-nums"
      >
        <span className="text-accent/70">MMR</span>
        <span>{fmtMmr(fallbackMmr)}</span>
      </span>
    );
  }
  return null;
}

/**
 * Per-race 1v1 MMR table for the opponent deep-dive. Renders nothing
 * when the breakdown didn't resolve (no Pulse id, or SC2Pulse
 * unreachable) so an un-resolvable opponent's profile looks like it
 * did before.
 */
export function RaceMmrPanel({
  breakdown,
  isLoading,
  confirmedIdentity,
}: {
  breakdown: PulseRaceBreakdown | undefined;
  isLoading: boolean;
  confirmedIdentity?: GlobalPlayerIdentity | null;
}) {
  const currentSource = matchesConfirmedIdentity(breakdown, confirmedIdentity);
  if (isLoading && (!breakdown || !currentSource)) {
    return (
      <Card title="MMR by race">
        <Skeleton rows={3} />
      </Card>
    );
  }
  if (!breakdown || !currentSource) return null;
  if (!breakdown.resolved || breakdown.races.length === 0) {
    if (breakdown.ladderIdentity?.confirmed) {
      return (
        <Card title="MMR by race">
          <p className="text-caption text-text-muted">Current ladder ratings are unavailable for the confirmed main profile.</p>
          <LadderMmrSource breakdown={breakdown} />
        </Card>
      );
    }
    return null;
  }
  return (
    <Card title="MMR by race">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-micro uppercase tracking-wider text-text-dim">
              <th className="py-2 pr-3 font-semibold">Race</th>
              <th className="py-2 pr-3 text-right font-semibold">MMR</th>
              <th
                className="py-2 pr-3 text-right font-semibold"
                title="Games played this ladder season (live from SC2Pulse)"
              >
                Season games
              </th>
              <th className="py-2 text-right font-semibold">League</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.races.map((r) => {
              const race = coerceRace(r.race);
              const tint = raceTint(race);
              return (
                <tr key={r.race} className="border-t border-border">
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center gap-1.5 ${tint.text}`}>
                      <Icon
                        name={raceIconName(race)}
                        kind="race"
                        className="h-4 w-4"
                      />
                      <span className="font-medium">{race}</span>
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-text">
                    {fmtMmr(r.mmr)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-text-muted">
                    {r.games.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-text-muted">
                    {r.league || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <LadderMmrSource breakdown={breakdown} />
    </Card>
  );
}

function LadderMmrSource({ breakdown }: { breakdown: PulseRaceBreakdown }) {
  const source = breakdown.ladderIdentity;
  return (
    <p className="mt-3 text-micro text-text-dim">
      SC2Pulse 1v1 ladder · current season
      {source?.confirmed ? ` · ${source.displayName}'s confirmed main profile` : " · recorded account"}
      {source?.pulseCharacterId ? (
        <> · <a className="text-accent hover:underline" href={sc2pulseCharacterUrl(source.pulseCharacterId)} target="_blank" rel="noopener noreferrer">View SC2Pulse profile</a></>
      ) : null}
    </p>
  );
}
