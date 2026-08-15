"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  Dices,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import {
  setOpeningUnitCustomWeights,
  setOpeningUnitGateCount,
  setOpeningUnitWeight,
  setUnitRandomizerEnabled,
  toggleOpeningUnit,
} from "@/lib/randomizer/config";
import { normalizeProbabilities } from "@/lib/randomizer/engine";
import {
  GATEWAY_UNITS,
  defaultOpeningUnitsForBuild,
} from "@/lib/randomizer/gatewayUnits";
import {
  matchupRaces,
  type GatewayCount,
  type GatewayUnitId,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitsConfig,
  type RandomizerBuild,
} from "@/lib/randomizer/types";

export interface BuildUnitRollEditorProps {
  matchup: MatchupKey;
  config: MatchupConfig;
  onChange: (next: MatchupConfig) => void;
}

/**
 * Compact, per-build editor for the optional Gateway-unit draw that follows
 * the build-order reveal. Only one build is expanded at a time so a large
 * randomizer pool stays easy to scan.
 */
export function BuildUnitRollEditor({
  matchup,
  config,
  onChange,
}: BuildUnitRollEditorProps) {
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const { my } = matchupRaces(matchup);
  const builds = useMemo(
    () => config.builds.filter((build) => build.race === "Protoss"),
    [config.builds],
  );

  useEffect(() => {
    setExpandedBuildId((current) =>
      current && builds.some((build) => build.id === current) ? current : null,
    );
  }, [builds, matchup]);

  if (my !== "Protoss") return null;

  return (
    <Section
      title="Opening Gateway draw"
      description="After a build wins and its reveal clears, draw one opening unit for a 1 Gate build or two for a 2 Gate build. Each build keeps its own unit odds."
    >
      <div className="space-y-3">
        <Card>
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-body font-medium text-text">
                  <Sparkles
                    className="h-4 w-4 text-accent-cyan"
                    aria-hidden
                  />
                  Randomize opening Gateway units
                </span>
                <span className="mt-0.5 block text-caption text-text-muted">
                  Runs automatically after the winning build leaves the screen.
                </span>
              </span>
              <Toggle
                checked={config.unitRandomizerEnabled}
                onChange={(enabled) =>
                  onChange(setUnitRandomizerEnabled(config, enabled))
                }
                disabled={!config.enabled}
                label={`Randomize opening Gateway units for ${matchup}`}
              />
            </div>

            <RevealSequence />
          </div>
        </Card>

        {builds.length === 0 ? (
          <Card>
            <p className="px-2 py-3 text-caption text-text-muted">
              Select at least one build above to set its opening units.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {builds.map((build) => {
              const opening = openingFor(build, matchup);
              const expanded = expandedBuildId === build.id;
              return (
                <BuildDisclosure
                  key={build.id}
                  build={build}
                  opening={opening}
                  config={config}
                  expanded={expanded}
                  onToggle={() =>
                    setExpandedBuildId((current) =>
                      current === build.id ? null : build.id,
                    )
                  }
                  onChange={onChange}
                />
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}

function RevealSequence() {
  return (
    <div
      className="grid gap-2 rounded-lg border border-accent-cyan/20 bg-accent-cyan/5 p-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center"
      aria-label="Reveal sequence: build chosen, build reveal clears, opening units are drawn"
    >
      <SequenceStep number="1" label="Build chosen" detail="Weighted build roll" />
      <ArrowRight
        className="hidden h-4 w-4 text-accent-cyan/70 sm:block"
        aria-hidden
      />
      <SequenceStep number="2" label="Screen clears" detail="A clean pause" />
      <ArrowRight
        className="hidden h-4 w-4 text-accent-cyan/70 sm:block"
        aria-hidden
      />
      <SequenceStep number="3" label="Unit draw" detail="One or two picks" />
    </div>
  );
}

function SequenceStep({
  number,
  label,
  detail,
}: {
  number: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-bg-surface text-micro font-bold text-accent-cyan"
      >
        {number}
      </span>
      <span className="min-w-0">
        <span className="block text-caption font-semibold text-text">
          {label}
        </span>
        <span className="block text-micro text-text-muted">{detail}</span>
      </span>
    </div>
  );
}

function BuildDisclosure({
  build,
  opening,
  config,
  expanded,
  onToggle,
  onChange,
}: {
  build: RandomizerBuild;
  opening: OpeningUnitsConfig;
  config: MatchupConfig;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: MatchupConfig) => void;
}) {
  const safeId = safeDomId(build.id);
  const panelId = `opening-units-panel-${safeId}`;
  const selectedIds = new Set(opening.units.map((unit) => unit.id));
  const oddsLabel = opening.useCustomWeights ? "Custom odds" : "Equal odds";

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
          <span className="block truncate text-body font-semibold text-text">
            {build.name}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro uppercase tracking-wider text-text-muted">
            <span>{opening.gateCount} Gate{opening.gateCount === 2 ? "s" : ""}</span>
            <span aria-hidden>·</span>
            <span>{opening.units.length} units</span>
            <span aria-hidden>·</span>
            <span>{oddsLabel}</span>
          </span>
        </span>
        <span
          className="hidden items-center gap-1 sm:flex"
          aria-label={`${opening.units.length} eligible units`}
        >
          {GATEWAY_UNITS.filter((unit) => selectedIds.has(unit.id)).map(
            (unit) => (
              <span
                key={unit.id}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-surface"
              >
                <Icon
                  name={unit.name}
                  kind="unit"
                  size={24}
                  decorative
                />
              </span>
            ),
          )}
        </span>
        <ChevronDown
          className={[
            "h-4 w-4 flex-shrink-0 text-text-muted transition-transform",
            expanded ? "rotate-180" : "",
          ].join(" ")}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-border px-3 py-4 sm:px-4">
          <div className="space-y-4">
            <GateCountControl
              build={build}
              value={opening.gateCount}
              onChange={(gateCount) =>
                onChange(setOpeningUnitGateCount(config, build.id, gateCount))
              }
            />

            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-text">
                  Use custom unit odds
                </span>
                <span className="mt-0.5 block text-caption text-text-muted">
                  Off gives every selected unit an equal chance. On uses the
                  sliders below.
                </span>
              </span>
              <Toggle
                checked={opening.useCustomWeights}
                onChange={(useCustomWeights) =>
                  onChange(
                    setOpeningUnitCustomWeights(
                      config,
                      build.id,
                      useCustomWeights,
                    ),
                  )
                }
                label={`Use custom opening-unit odds for ${build.name}`}
              />
            </div>

            <UnitPoolEditor
              build={build}
              opening={opening}
              config={config}
              onChange={onChange}
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function GateCountControl({
  build,
  value,
  onChange,
}: {
  build: RandomizerBuild;
  value: GatewayCount;
  onChange: (next: GatewayCount) => void;
}) {
  const name = `opening-gate-count-${safeDomId(build.id)}`;
  return (
    <fieldset>
      <legend className="text-caption font-semibold text-text">
        Opening production
      </legend>
      <p className="mt-0.5 text-caption text-text-muted">
        Choose how many first Gateway units this build should draw.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup">
        {([1, 2] as const).map((count) => (
          <label key={count} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={count}
              checked={value === count}
              onChange={() => onChange(count)}
              className="peer sr-only"
              aria-label={`${count} Gateway${count === 2 ? "s" : ""} for ${build.name}`}
            />
            <span className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 text-caption font-semibold text-text transition-colors hover:border-border-strong peer-checked:border-accent-cyan peer-checked:bg-accent-cyan/10 peer-checked:text-accent-cyan peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg">
              <span className="flex items-center -space-x-1" aria-hidden>
                {Array.from({ length: count }).map((_, index) => (
                  <Icon
                    key={index}
                    name="Gateway"
                    kind="building"
                    size={22}
                    decorative
                  />
                ))}
              </span>
              {count} Gate{count === 2 ? "s" : ""}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-micro text-text-muted">
        {value === 1
          ? "Draws one opening unit."
          : "Draws twice from these odds. Picks are independent, so repeats are possible."}
      </p>
    </fieldset>
  );
}

function UnitPoolEditor({
  build,
  opening,
  config,
  onChange,
}: {
  build: RandomizerBuild;
  opening: OpeningUnitsConfig;
  config: MatchupConfig;
  onChange: (next: MatchupConfig) => void;
}) {
  const poolHintId = `opening-unit-pool-hint-${safeDomId(build.id)}`;
  const selectedById = new Map(opening.units.map((unit) => [unit.id, unit]));
  const effectiveWeights = opening.units.map((unit) =>
    opening.useCustomWeights ? unit.weight : 1,
  );
  const probabilities = normalizeProbabilities(effectiveWeights);
  const probabilityById = new Map<GatewayUnitId, number>();
  opening.units.forEach((unit, index) => {
    probabilityById.set(unit.id, probabilities[index] ?? 0);
  });

  function changeWeight(unitId: GatewayUnitId, weight: number) {
    const otherPositiveTotal = opening.units.reduce(
      (sum, unit) =>
        unit.id === unitId ? sum : sum + Math.max(0, unit.weight),
      0,
    );
    const safeWeight = weight <= 0 && otherPositiveTotal <= 0 ? 0.1 : weight;
    onChange(setOpeningUnitWeight(config, build.id, unitId, safeWeight));
  }

  return (
    <fieldset>
      <legend className="text-caption font-semibold text-text">
        Eligible units
      </legend>
      <p id={poolHintId} className="mt-0.5 text-caption text-text-muted">
        Keep at least one unit selected. Percentages always show the final
        normalized chance.
      </p>
      <div className="mt-2 overflow-hidden rounded-lg border border-border bg-bg-surface">
        <ul className="divide-y divide-border">
          {GATEWAY_UNITS.map((unit) => {
            const selected = selectedById.get(unit.id);
            const isLastSelected = Boolean(selected) && opening.units.length === 1;
            const probability = probabilityById.get(unit.id) ?? 0;
            return (
              <li
                key={unit.id}
                className="flex min-h-[58px] flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={Boolean(selected)}
                    disabled={isLastSelected}
                    aria-describedby={poolHintId}
                    aria-label={`Include ${unit.name} in the opening draw for ${build.name}`}
                    onChange={(event) =>
                      onChange(
                        toggleOpeningUnit(
                          config,
                          build.id,
                          unit.id,
                          event.target.checked,
                        ),
                      )
                    }
                    className="h-5 w-5 flex-shrink-0 cursor-pointer accent-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
                  />
                  <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-bg-elevated">
                    <Icon
                      name={unit.name}
                      kind="unit"
                      size={32}
                      decorative
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium text-text">
                      {unit.name}
                    </span>
                    <span className="block text-caption tabular-nums text-text-muted">
                      {selected ? `${(probability * 100).toFixed(1)}% chance` : "Not in pool"}
                    </span>
                  </span>
                </label>

                {selected && opening.useCustomWeights ? (
                  <UnitWeightSlider
                    buildName={build.name}
                    unitName={unit.name}
                    value={selected.weight}
                    probability={probability}
                    onChange={(weight) => changeWeight(unit.id, weight)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </fieldset>
  );
}

function UnitWeightSlider({
  buildName,
  unitName,
  value,
  probability,
  onChange,
}: {
  buildName: string;
  unitName: string;
  value: number;
  probability: number;
  onChange: (next: number) => void;
}) {
  const pct = (probability * 100).toFixed(1);
  return (
    <div className="flex w-full flex-shrink-0 items-center gap-2 sm:w-64">
      <input
        type="range"
        min={0}
        max={10}
        step={0.1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`Selection weight for ${unitName} in ${buildName}`}
        aria-valuetext={`${value.toFixed(1)} weight, ${pct} percent selection chance`}
        className="h-1 flex-1 cursor-pointer accent-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="w-10 flex-shrink-0 text-right text-caption tabular-nums text-text">
        {value.toFixed(1)}
      </span>
      <span className="w-14 flex-shrink-0 text-right text-caption tabular-nums text-accent-cyan">
        {pct}%
      </span>
    </div>
  );
}

function openingFor(
  build: RandomizerBuild,
  matchup: MatchupKey,
): OpeningUnitsConfig {
  return build.openingUnits ?? defaultOpeningUnitsForBuild(matchup, build.name);
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
