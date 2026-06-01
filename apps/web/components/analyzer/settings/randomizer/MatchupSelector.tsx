"use client";

/**
 * Nine-matchup chip row for the Settings → Randomizer tab. Each chip
 * shows how many builds are configured + whether the matchup is
 * enabled, so the streamer sees coverage at a glance.
 */
import { RaceIcon } from "@/components/overlay/WidgetShell";
import { raceTint } from "@/lib/race";
import {
  MATCHUPS,
  matchupRaces,
  type MatchupKey,
  type RandomizerConfig,
} from "@/lib/randomizer/types";

export interface MatchupSelectorProps {
  config: RandomizerConfig;
  active: MatchupKey;
  onSelect: (m: MatchupKey) => void;
}

export function MatchupSelector({
  config,
  active,
  onSelect,
}: MatchupSelectorProps) {
  return (
    <div
      role="tablist"
      aria-label="Matchups"
      className="grid grid-cols-3 gap-2 sm:grid-cols-3 lg:grid-cols-9"
    >
      {MATCHUPS.map((m) => (
        <MatchupChip
          key={m}
          matchup={m}
          isActive={m === active}
          buildCount={config.matchups[m].builds.length}
          enabled={config.matchups[m].enabled}
          onClick={() => onSelect(m)}
        />
      ))}
    </div>
  );
}

function MatchupChip({
  matchup,
  isActive,
  buildCount,
  enabled,
  onClick,
}: {
  matchup: MatchupKey;
  isActive: boolean;
  buildCount: number;
  enabled: boolean;
  onClick: () => void;
}) {
  const { my, vs } = matchupRaces(matchup);
  const tint = raceTint(my);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={[
        "flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        isActive
          ? `${tint.border} ${tint.bg}`
          : "border-border bg-bg-elevated hover:bg-bg-surface",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5">
        <RaceIcon race={my} size={18} />
        <span className="text-caption font-bold text-text-muted">vs</span>
        <RaceIcon race={vs} size={18} />
      </div>
      <div className={["text-caption font-bold", isActive ? tint.text : "text-text"].join(" ")}>
        {matchup}
      </div>
      <div className="flex items-center gap-1 text-micro uppercase tracking-wider text-text-muted">
        <span>{buildCount} build{buildCount === 1 ? "" : "s"}</span>
        {enabled ? (
          <span aria-label="Enabled" className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />
        ) : null}
      </div>
    </button>
  );
}
