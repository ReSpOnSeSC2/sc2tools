"use client";

/**
 * Race, then matchup, for Settings → Randomizer. The race row picks whose
 * matchups show; switching race keeps the opponent (PvZ → TvZ). Each
 * matchup chip says what it draws, so coverage reads at a glance.
 */
import { RaceIcon } from "@/components/overlay/WidgetShell";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { matchupDraws } from "@/lib/randomizer/config";
import {
  MATCHUPS,
  isMatchupKey,
  matchupRaces,
  playedRace,
  type MatchupConfig,
  type MatchupKey,
  type PlayedRace,
  type RandomizerConfig,
} from "@/lib/randomizer/types";

export interface MatchupSelectorProps {
  config: RandomizerConfig;
  active: MatchupKey;
  onSelect: (m: MatchupKey) => void;
}

const RACES: readonly PlayedRace[] = ["Protoss", "Terran", "Zerg"];

const RACE_OPTIONS: ReadonlyArray<SegmentedOption<PlayedRace>> = RACES.map((race) => ({
  value: race,
  label: (
    <span className="inline-flex items-center gap-1.5 px-1">
      <RaceIcon race={race} size={16} />
      {race}
    </span>
  ),
}));

/** The same opponent, played as `race`. */
function sameOpponent(active: MatchupKey, race: PlayedRace): MatchupKey {
  const key = `${race[0]}v${active[2]}`;
  return isMatchupKey(key) ? key : active;
}

export function MatchupSelector({ config, active, onSelect }: MatchupSelectorProps) {
  const race = playedRace(active);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span id="randomizer-race-label" className="text-caption font-semibold text-text">
          Your race
        </span>
        <SegmentedControl
          labelledBy="randomizer-race-label"
          value={race}
          options={RACE_OPTIONS}
          onChange={(next) => onSelect(sameOpponent(active, next))}
        />
      </div>
      <div role="tablist" aria-label="Matchups" className="grid grid-cols-3 gap-2">
        {MATCHUPS.filter((m) => playedRace(m) === race).map((m) => (
          <MatchupChip
            key={m}
            matchup={m}
            isActive={m === active}
            config={config.matchups[m]}
            onClick={() => onSelect(m)}
          />
        ))}
      </div>
    </div>
  );
}

type DrawsLabel = "Both" | "Build" | "Units" | "Off";

/** What a matchup draws, from its two switches, in one word. */
export function drawsLabel(config: MatchupConfig): DrawsLabel {
  const draws = matchupDraws(config);
  if (draws.build && draws.units) return "Both";
  if (draws.build) return "Build";
  return draws.units ? "Units" : "Off";
}

const CHIP_SPEECH: Readonly<Record<DrawsLabel, string>> = {
  Both: "draws a build and opening units",
  Build: "draws a build",
  Units: "draws opening units",
  Off: "draws nothing",
};

function MatchupChip({
  matchup,
  isActive,
  config,
  onClick,
}: {
  matchup: MatchupKey;
  isActive: boolean;
  config: MatchupConfig;
  onClick: () => void;
}) {
  const { my, vs } = matchupRaces(matchup);
  const label = drawsLabel(config);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={`${matchup}, ${CHIP_SPEECH[label]}`}
      onClick={onClick}
      className={[
        "flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        isActive
          ? "border-accent-cyan bg-accent-cyan/10"
          : "border-border bg-bg-elevated hover:bg-bg-surface",
      ].join(" ")}
    >
      <span className="flex items-center gap-1.5" aria-hidden>
        <RaceIcon race={my} size={18} />
        <span className="text-caption font-bold text-text-muted">vs</span>
        <RaceIcon race={vs} size={18} />
      </span>
      <span className={["text-caption font-bold", isActive ? "text-accent-cyan" : "text-text"].join(" ")}>
        {matchup}
      </span>
      <span className="flex items-center gap-1 text-micro uppercase tracking-wider text-text-muted">
        {label === "Off" ? null : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />}
        {label}
      </span>
    </button>
  );
}
