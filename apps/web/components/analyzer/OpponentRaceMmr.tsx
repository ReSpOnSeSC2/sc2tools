"use client";

import { Icon } from "@/components/ui/Icon";
import { Card, Skeleton } from "@/components/ui/Card";
import { fmtMmr } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";

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
  mostPlayedVsYouRace: string | null;
  mostPlayedVsYouMmr: number | null;
};

export type MmrMode = "top" | "vsYou";

export function isMmrMode(v: unknown): v is MmrMode {
  return v === "top" || v === "vsYou";
}

/**
 * Pick the headline MMR for the chosen mode. "vsYou" prefers the race
 * the opponent played against this user the most; falls back to their
 * top race when that race has no current ladder team (or wasn't
 * resolved). Returns null when there's no resolved breakdown, so the
 * caller can fall back to the single stored MMR.
 */
export function selectHeadlineMmr(
  b: PulseRaceBreakdown | undefined,
  mode: MmrMode,
): { mmr: number; race: string } | null {
  if (!b || !b.resolved) return null;
  if (
    mode === "vsYou"
    && typeof b.mostPlayedVsYouMmr === "number"
    && b.mostPlayedVsYouRace
  ) {
    return { mmr: b.mostPlayedVsYouMmr, race: b.mostPlayedVsYouRace };
  }
  if (typeof b.topMmr === "number" && b.topRace) {
    return { mmr: b.topMmr, race: b.topRace };
  }
  return null;
}

/**
 * Whether the Top ⇄ vs-you toggle is meaningful — only when the two
 * modes would actually resolve to different races (i.e. the opponent's
 * top race isn't the one they played you the most).
 */
export function headlineModesDiffer(b: PulseRaceBreakdown | undefined): boolean {
  if (!b || !b.resolved) return false;
  if (!b.mostPlayedVsYouRace || !b.topRace) return false;
  return b.mostPlayedVsYouRace !== b.topRace;
}

/**
 * Last-known MMR pill for the opponent profile header. When the
 * per-race breakdown resolved, shows the MMR for the selected mode,
 * tinted + labelled with that race. Otherwise falls back to the single
 * stored ``fallbackMmr`` (the most-recent-game value) so behaviour
 * matches the pre-breakdown UI when SC2Pulse is unreachable.
 */
export function HeadlineMmrChip({
  breakdown,
  mode,
  fallbackMmr,
}: {
  breakdown: PulseRaceBreakdown | undefined;
  mode: MmrMode;
  fallbackMmr?: number | null;
}) {
  const selected = selectHeadlineMmr(breakdown, mode);
  if (selected) {
    const race = coerceRace(selected.race);
    const tint = raceTint(race);
    return (
      <span
        role="note"
        aria-label={`${race} MMR ${selected.mmr}`}
        title={
          mode === "vsYou"
            ? "MMR of the race they played you the most"
            : "Highest-rated race"
        }
        className={`inline-flex items-center gap-1.5 rounded-full border ${tint.border} ${tint.bg} px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${tint.text} tabular-nums`}
      >
        <Icon name={raceIconName(race)} kind="race" className="h-3.5 w-3.5" />
        <span>{fmtMmr(selected.mmr)}</span>
      </span>
    );
  }
  if (typeof fallbackMmr === "number" && fallbackMmr > 0) {
    return (
      <span
        role="note"
        aria-label={`Last known MMR ${Math.round(fallbackMmr)}`}
        title="Last known MMR — most recent game on record"
        className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-accent tabular-nums"
      >
        <span className="text-accent/70">MMR</span>
        <span>{fmtMmr(fallbackMmr)}</span>
      </span>
    );
  }
  return null;
}

/**
 * Per-race 1v1 MMR table for the opponent deep-dive, with a Top ⇄
 * vs-you toggle that drives the header headline. Renders nothing when
 * the breakdown didn't resolve (no Pulse id, or SC2Pulse unreachable)
 * so an un-resolvable opponent's profile looks like it did before.
 */
export function RaceMmrPanel({
  breakdown,
  isLoading,
  mode,
  onModeChange,
}: {
  breakdown: PulseRaceBreakdown | undefined;
  isLoading: boolean;
  mode: MmrMode;
  onModeChange: (m: MmrMode) => void;
}) {
  if (isLoading && !breakdown) {
    return (
      <Card title="Ladder MMR by race">
        <Skeleton rows={3} />
      </Card>
    );
  }
  if (!breakdown || !breakdown.resolved || breakdown.races.length === 0) {
    return null;
  }
  const vsYouRace = breakdown.mostPlayedVsYouRace;
  const canToggle = headlineModesDiffer(breakdown);
  return (
    <Card
      title="Ladder MMR by race"
      right={
        canToggle ? (
          <div
            className="inline-flex rounded-md border border-border bg-bg-elevated p-0.5 text-[11px]"
            role="group"
            aria-label="Headline MMR mode"
          >
            <ModeButton
              active={mode === "top"}
              onClick={() => onModeChange("top")}
            >
              Top MMR
            </ModeButton>
            <ModeButton
              active={mode === "vsYou"}
              onClick={() => onModeChange("vsYou")}
            >
              Most vs you
            </ModeButton>
          </div>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-text-dim">
              <th className="py-1.5 pr-3 font-semibold">Race</th>
              <th className="py-1.5 pr-3 text-right font-semibold">MMR</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Games</th>
              <th className="py-1.5 text-right font-semibold">League</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.races.map((r) => {
              const race = coerceRace(r.race);
              const tint = raceTint(race);
              const isVsYou = vsYouRace === r.race;
              return (
                <tr key={r.race} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    <span className={`inline-flex items-center gap-1.5 ${tint.text}`}>
                      <Icon
                        name={raceIconName(race)}
                        kind="race"
                        className="h-4 w-4"
                      />
                      <span className="font-medium">{race}</span>
                      {isVsYou ? (
                        <span
                          title="The race they played you the most"
                          className="rounded-sm bg-bg-elevated px-1 text-[9px] uppercase tracking-wider text-text-dim"
                        >
                          vs you
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-text">
                    {fmtMmr(r.mmr)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-text-muted">
                    {r.games.toLocaleString()}
                  </td>
                  <td className="py-1.5 text-right text-text-muted">
                    {r.league || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-text-dim">
        Live from SC2Pulse (1v1, current season). The header MMR shows
        {mode === "vsYou" ? " the race they played you the most" : " their highest race"}.
      </p>
    </Card>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "rounded px-2 py-0.5 font-medium uppercase tracking-wider transition-colors",
        active
          ? "bg-accent text-white"
          : "text-text-muted hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
