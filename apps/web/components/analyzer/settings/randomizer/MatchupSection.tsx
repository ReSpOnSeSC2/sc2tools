"use client";

/**
 * Settings → Randomizer's first card: race, matchup and what that matchup
 * draws, then the desktop roll that serves every matchup.
 * `RandomizerSkeleton` holds this card's shape while the settings load.
 */
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { activeMatchupCount } from "@/lib/randomizer/config";
import type { MatchupConfig, MatchupKey, RandomizerConfig } from "@/lib/randomizer/types";
import { DrawSwitches } from "./DrawSwitches";
import { MatchupSelector } from "./MatchupSelector";

/** The section's words before any matchup draws, shared with the loading skeleton. */
export const RANDOMIZER_INTRO = "Pick your race and matchup, then what each game draws: a build order, opening units or both.";
export const DESKTOP_ROLL_COPY = {
  title: "Roll on the desktop card when I'm not streaming",
  description: "The paired agent can show a build in an eligible 1v1 when no enabled randomizer source is connected.",
} as const;

export interface MatchupSectionProps {
  draft: RandomizerConfig;
  active: MatchupKey;
  onSelect: (matchup: MatchupKey) => void;
  onChange: (next: MatchupConfig) => void;
  desktop: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
}

export function MatchupSection({ draft, active, onSelect, onChange, desktop }: MatchupSectionProps) {
  const activeCount = activeMatchupCount(draft);
  return (
    <Section
      id="build-randomizer" className="scroll-mt-28"
      title="Build randomizer"
      description={
        activeCount === 0
          ? RANDOMIZER_INTRO
          : `Draws on ${activeCount} matchup${activeCount === 1 ? "" : "s"}. Pick one to change what it draws.`
      }
    >
      <Card>
        <MatchupSelector config={draft} active={active} onSelect={onSelect} />
        <div className="mt-4 border-t border-border pt-4">
          <DrawSwitches matchup={active} config={draft.matchups[active]} onChange={onChange} />
        </div>
        <label className="mt-4 flex min-h-11 items-start gap-3 border-t border-border pt-4">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent"
            checked={desktop.checked} disabled={desktop.disabled}
            onChange={(event) => desktop.onChange(event.target.checked)} />
          <span className="min-w-0 text-body font-medium text-text">
            {DESKTOP_ROLL_COPY.title}
            <span className="mt-1 block text-caption font-normal text-text-muted">{DESKTOP_ROLL_COPY.description}</span>
          </span>
        </label>
      </Card>
    </Section>
  );
}
