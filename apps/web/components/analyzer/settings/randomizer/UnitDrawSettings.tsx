"use client";

/**
 * Settings → Randomizer → Opening units, for one matchup: the matchup's own
 * unit draw, shown while a draw uses it (no build drawn, or a build saved
 * without units of its own), then, while a build is drawn, each selected
 * build's. Only one build is expanded at a time so a large pool stays easy
 * to scan.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Dices, Info } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { setBuildOpeningUnits } from "@/lib/randomizer/config";
import { openingUnitMeta } from "@/lib/randomizer/openingUnits";
import { MATCHUP_UNIT_POOLS, defaultMatchupUnits } from "@/lib/randomizer/openingUnitPools";
import {
  playedRace,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitsConfig,
  type PlayedRace,
  type RandomizerBuild,
} from "@/lib/randomizer/types";
import { OpeningUnitsEditor } from "./OpeningUnitsEditor";

export interface UnitDrawSettingsProps {
  matchup: MatchupKey;
  config: MatchupConfig;
  onChange: (next: MatchupConfig) => void;
}

export function UnitDrawSettings({ matchup, config, onChange }: UnitDrawSettingsProps) {
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const race = playedRace(matchup);
  const matchupUnits = config.units ?? defaultMatchupUnits(matchup);
  const builds = useMemo(
    () => (config.enabled ? config.builds.filter((build) => build.race === race) : []),
    [config.enabled, config.builds, race],
  );

  useEffect(() => {
    setExpandedBuildId((current) => (current && builds.some((build) => build.id === current) ? current : null));
  }, [builds, matchup]);
  // Every Protoss pool entry, and every build added here, has units of its own.
  const matchupUnitsUsed = !config.enabled || builds.some((build) => !build.openingUnits);

  return (
    <Section
      id="unit-draw" className="scroll-mt-28"
      title="Opening units"
      description={race === "Protoss"
        ? "Protoss draws its Gateway units."
        : `The units ${matchup}'s pre-made builds are named for.`}
    >
      <div className="space-y-3">
        {config.unitRandomizerEnabled ? null : (
          <Note>Draw opening units is off for {matchup}. These settings apply once it is on.</Note>
        )}
        {matchupUnitsUsed ? (
          <MatchupUnitsCard
            matchup={matchup}
            caption={config.enabled ? "Used by builds that have no units of their own." : "The draw when no build is drawn."}
            value={matchupUnits}
            onChange={(units) => onChange({ ...config, units })}
          />
        ) : null}
        {config.enabled && builds.length === 0 ? (
          <Note>Add a build to the {matchup} pool, then set the units it draws here.</Note>
        ) : null}
        {builds.length > 0 ? (
          <div className="space-y-2">
            <h3 className="pt-2 text-body font-semibold text-text">Each build&apos;s units</h3>
            {builds.map((build) => (
              <BuildDisclosure
                key={build.id}
                build={build}
                matchup={matchup}
                matchupUnits={matchupUnits}
                expanded={expandedBuildId === build.id}
                onToggle={() => setExpandedBuildId((current) => (current === build.id ? null : build.id))}
                onChange={(opening) => onChange(setBuildOpeningUnits(config, build.id, opening))}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** The matchup's own unit draw. */
function MatchupUnitsCard({ matchup, caption, value, onChange }: {
  matchup: MatchupKey;
  caption: string;
  value: OpeningUnitsConfig;
  onChange: (next: OpeningUnitsConfig) => void;
}) {
  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-body font-semibold text-text">{matchup} units</h3>
          <p className="mt-0.5 text-caption text-text-muted">{caption}</p>
        </div>
        <OpeningUnitsEditor
          idPrefix={`unit-draw-${matchup}`}
          subject={matchup}
          race={playedRace(matchup)}
          eligible={MATCHUP_UNIT_POOLS[matchup]}
          value={value}
          onChange={onChange}
        />
      </div>
    </Card>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2.5 text-caption text-text-muted">
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-dim" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function summaryOf(opening: OpeningUnitsConfig, race: PlayedRace, own: boolean): string[] {
  const count = race === "Protoss"
    ? `${opening.gateCount} Gate${opening.gateCount === 2 ? "s" : ""}`
    : `Draws ${opening.gateCount}`;
  return [
    own ? count : "Same as the matchup",
    `${opening.units.length} unit${opening.units.length === 1 ? "" : "s"}`,
    opening.useCustomWeights ? "Custom odds" : "Equal odds",
  ];
}

function BuildDisclosure({
  build, matchup, matchupUnits, expanded, onToggle, onChange,
}: {
  build: RandomizerBuild;
  matchup: MatchupKey;
  matchupUnits: OpeningUnitsConfig;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: OpeningUnitsConfig) => void;
}) {
  const race = playedRace(matchup);
  const safeId = safeDomId(build.id);
  const panelId = `opening-units-panel-${safeId}`;
  // A Terran or Zerg build saved before it had units draws with the matchup's.
  const opening = build.openingUnits ?? matchupUnits;
  return (
    <Card padded={false}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-[64px] w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-accent-cyan/25 bg-accent-cyan/10">
          <Dices className="h-5 w-5 text-accent-cyan" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-semibold text-text">{build.name}</span>
          <SummaryLine parts={summaryOf(opening, race, build.openingUnits !== undefined)} />
        </span>
        <UnitIcons opening={opening} />
        <ChevronDown
          className={["h-4 w-4 flex-shrink-0 text-text-muted transition-transform motion-reduce:transition-none", expanded ? "rotate-180" : ""].join(" ")}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div id={panelId} className="border-t border-border px-3 py-4 sm:px-4">
          <OpeningUnitsEditor
            idPrefix={`opening-units-${safeId}`}
            subject={build.name}
            race={race}
            eligible={MATCHUP_UNIT_POOLS[matchup]}
            value={opening}
            onChange={onChange}
          />
        </div>
      ) : null}
    </Card>
  );
}

function SummaryLine({ parts }: { parts: string[] }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro uppercase tracking-wider text-text-muted">
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

/** Up to five of the build's units, on screens wide enough for them. */
function UnitIcons({ opening }: { opening: OpeningUnitsConfig }) {
  return (
    <span className="hidden items-center gap-1 sm:flex" aria-label={`${opening.units.length} eligible units`}>
      {opening.units.slice(0, 5).map((unit) => (
        <span key={unit.id} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-surface">
          <Icon name={openingUnitMeta(unit.id).name} kind="unit" size={24} decorative />
        </span>
      ))}
    </span>
  );
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
