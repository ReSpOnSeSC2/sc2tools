"use client";

/**
 * The matchup's two independent switches, "Draw a build order" and "Draw
 * opening units", and one plain line on what a game will draw. Turning the
 * unit draw on gives the matchup its default units the first time.
 */
import type { ReactNode } from "react";
import { Dices, Sparkles } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { defaultMatchupUnits } from "@/lib/randomizer/openingUnitPools";
import type { MatchupConfig, MatchupKey } from "@/lib/randomizer/types";

export interface DrawSwitchesProps {
  matchup: MatchupKey;
  config: MatchupConfig;
  onChange: (next: MatchupConfig) => void;
}

/** What one game of `matchup` draws under these switches, in a sentence. */
export function drawSummary(matchup: MatchupKey, config: MatchupConfig): string {
  if (config.enabled && config.unitRandomizerEnabled) return `Each ${matchup} game draws a build, then its opening units.`;
  if (config.enabled) return `Each ${matchup} game draws a build.`;
  if (config.unitRandomizerEnabled) return `Each ${matchup} game draws opening units, for whatever build you play.`;
  return `Nothing is drawn for ${matchup}.`;
}

/** The unit switch; the first time it turns on, the matchup gets its default units. */
function withUnitSwitch(matchup: MatchupKey, config: MatchupConfig, on: boolean): MatchupConfig {
  const next = { ...config, unitRandomizerEnabled: on };
  return on && !config.units ? { ...next, units: defaultMatchupUnits(matchup) } : next;
}

export function DrawSwitches({ matchup, config, onChange }: DrawSwitchesProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-caption font-semibold text-text">What to draw</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <SwitchRow
          id={`draw-build-${matchup}`}
          icon={<Dices className="h-4 w-4 text-accent-cyan" aria-hidden />}
          title="Draw a build order"
          description="A build from this matchup's pool at the start of each game."
          checked={config.enabled}
          onChange={(enabled) => onChange({ ...config, enabled })}
          label={`Draw a build order in ${matchup}`}
        />
        <SwitchRow
          id={`draw-units-${matchup}`}
          icon={<Sparkles className="h-4 w-4 text-accent-cyan" aria-hidden />}
          title="Draw opening units"
          description="Your first units, after the build or on their own."
          checked={config.unitRandomizerEnabled}
          onChange={(on) => onChange(withUnitSwitch(matchup, config, on))}
          label={`Draw opening units in ${matchup}`}
        />
      </div>
      <p className="text-caption text-text-muted" aria-live="polite">
        {drawSummary(matchup, config)}
      </p>
    </fieldset>
  );
}

function SwitchRow({
  id, icon, title, description, checked, onChange, label,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-body font-medium text-text">
          {icon}
          {title}
        </span>
        <span className="mt-0.5 block text-caption text-text-muted">{description}</span>
      </span>
      <Toggle id={id} checked={checked} onChange={onChange} label={label} className="mt-0.5" />
    </label>
  );
}
