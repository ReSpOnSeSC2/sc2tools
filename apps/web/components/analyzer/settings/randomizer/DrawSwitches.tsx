"use client";

/**
 * The matchup's two independent switches, "Draw a build order" and "Draw
 * opening units", and one plain line on what a game will draw. The unit
 * draw never ends up on without units: the matchup gets its defaults.
 */
import type { ReactNode } from "react";
import { Dices, Sparkles } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { matchupDraws } from "@/lib/randomizer/config";
import { defaultMatchupUnits } from "@/lib/randomizer/openingUnitPools";
import type { MatchupConfig, MatchupKey } from "@/lib/randomizer/types";

/** The switches' words, shared with the loading skeleton so it wraps where they do. */
export const DRAW_SWITCH_COPY = {
  build: { title: "Draw a build order", description: "A build from this matchup's pool at the start of each game." },
  units: { title: "Draw opening units", description: "Your first units, after the build or on their own." },
} as const;

export interface DrawSwitchesProps {
  matchup: MatchupKey;
  config: MatchupConfig;
  onChange: (next: MatchupConfig) => void;
}

/** What one game of `matchup` draws now, in a sentence, or what it still needs. */
export function drawSummary(matchup: MatchupKey, config: MatchupConfig): string {
  const draws = matchupDraws(config);
  if (draws.build && draws.units) return `Each ${matchup} game draws a build, then its opening units.`;
  if (draws.build) return `Each ${matchup} game draws a build.`;
  if (draws.units) return `Each ${matchup} game draws opening units, for whatever build you play.`;
  if (config.enabled) return `Nothing is drawn yet: add a build to the ${matchup} pool.`;
  if (config.unitRandomizerEnabled) return "Nothing is drawn yet: select at least one opening unit.";
  return `Nothing is drawn for ${matchup}.`;
}

/**
 * One switch's change. Whenever the unit draw ends up on with no units of
 * its own (turned on, or an older Protoss config's build draw turned off),
 * the matchup gets its default units, so the panel shows what a game draws.
 */
export function withDrawSwitch(
  matchup: MatchupKey,
  config: MatchupConfig,
  change: Partial<Pick<MatchupConfig, "enabled" | "unitRandomizerEnabled">>,
): MatchupConfig {
  const next = { ...config, ...change };
  return next.unitRandomizerEnabled && !next.units ? { ...next, units: defaultMatchupUnits(matchup) } : next;
}

export function DrawSwitches({ matchup, config, onChange }: DrawSwitchesProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-caption font-semibold text-text">What to draw</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <SwitchRow
          id={`draw-build-${matchup}`}
          icon={<Dices className="h-4 w-4 text-accent-cyan" aria-hidden />}
          title={DRAW_SWITCH_COPY.build.title}
          description={DRAW_SWITCH_COPY.build.description}
          checked={config.enabled}
          onChange={(enabled) => onChange(withDrawSwitch(matchup, config, { enabled }))}
          label={`Draw a build order in ${matchup}`}
        />
        <SwitchRow
          id={`draw-units-${matchup}`}
          icon={<Sparkles className="h-4 w-4 text-accent-cyan" aria-hidden />}
          title={DRAW_SWITCH_COPY.units.title}
          description={DRAW_SWITCH_COPY.units.description}
          checked={config.unitRandomizerEnabled}
          onChange={(on) => onChange(withDrawSwitch(matchup, config, { unitRandomizerEnabled: on }))}
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
