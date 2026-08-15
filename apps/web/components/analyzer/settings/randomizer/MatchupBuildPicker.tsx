"use client";

/**
 * Per-matchup configuration card — enable toggle, custom-weights toggle,
 * checklist of catalog + custom builds, and (when custom weights are
 * on) a normalized-percent slider for every selected build. Protoss
 * matchups also expose a compact second-stage opening-unit editor.
 */
import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RaceIcon } from "@/components/overlay/WidgetShell";
import type { PoolCandidate } from "@/lib/randomizer/pool";
import { candidatePool } from "@/lib/randomizer/pool";
import {
  effectiveWeight,
  normalizeProbabilities,
} from "@/lib/randomizer/engine";
import {
  setBuildWeight,
  toggleBuild,
} from "@/lib/randomizer/config";
import { defaultOpeningUnits } from "@/lib/randomizer/gatewayUnits";
import type { MatchupConfig, MatchupKey } from "@/lib/randomizer/types";
import { matchupRaces } from "@/lib/randomizer/types";
import type { CustomBuild } from "@/components/builds/types";
import { raceTint } from "@/lib/race";
import { BuildUnitRollEditor } from "./BuildUnitRollEditor";

export interface MatchupBuildPickerProps {
  matchup: MatchupKey;
  config: MatchupConfig;
  customBuilds: ReadonlyArray<CustomBuild>;
  onChange: (next: MatchupConfig) => void;
}

export function MatchupBuildPicker({
  matchup,
  config,
  customBuilds,
  onChange,
}: MatchupBuildPickerProps) {
  const pool = useMemo(
    () => candidatePool(matchup, customBuilds),
    [matchup, customBuilds],
  );
  const selectedIds = useMemo(
    () => new Set(config.builds.map((b) => b.id)),
    [config.builds],
  );
  const catalog = pool.filter((c) => c.source === "catalog");
  const custom = pool.filter((c) => c.source === "custom");

  const probabilities = useMemo(() => {
    const weights = config.builds.map((b) =>
      effectiveWeight(b, config.useCustomWeights),
    );
    return normalizeProbabilities(weights);
  }, [config.builds, config.useCustomWeights]);

  function toggle(candidate: PoolCandidate, on: boolean) {
    onChange(
      toggleBuild(
        config,
        {
          id: candidate.id,
          name: candidate.name,
          race: candidate.race,
          source: candidate.source,
          weight: 1,
          ...(candidate.race === "Protoss"
            ? { openingUnits: defaultOpeningUnits(candidate.suggestedGateCount) }
            : {}),
        },
        on,
      ),
    );
  }

  return (
    <div className="space-y-4">
      <MatchupHeader matchup={matchup} />
      <Card>
        <ToggleRow
          title="Enable randomizer for this matchup"
          description="When on, the OBS widget spins a random build for this matchup at the start of each new game."
          checked={config.enabled}
          onChange={(on) => onChange({ ...config, enabled: on })}
        />
        <div className="mt-3">
          <ToggleRow
            title="Use custom weights"
            description="Off: every selected build has equal chance. On: the sliders below set how likely each build is to land."
            checked={config.useCustomWeights}
            onChange={(on) => onChange({ ...config, useCustomWeights: on })}
            disabled={!config.enabled}
          />
        </div>
      </Card>

      {pool.length === 0 ? (
        <Card>
          <EmptyStatePanel
            title="No builds eligible for this matchup"
            description="The bundled catalog covers Protoss matchups for now — add a Custom build under Settings → Builds (with the right Race / vsRace) to populate Terran and Zerg matchups."
          />
        </Card>
      ) : (
        <>
          <Section
            title="Catalog builds"
            description="From the bundled BUILD_DEFINITIONS catalog (race-generic + matchup-specific entries)."
          >
            <BuildChecklist
              candidates={catalog}
              selectedIds={selectedIds}
              config={config}
              probabilities={probabilities}
              onToggle={toggle}
              onWeightChange={(id, w) => onChange(setBuildWeight(config, id, w))}
              emptyHint="No catalog entries match this matchup yet."
            />
          </Section>
          <Section
            title="Your custom builds"
            description="Custom builds whose race / vsRace fit this matchup. Add more under Settings → Builds."
          >
            <BuildChecklist
              candidates={custom}
              selectedIds={selectedIds}
              config={config}
              probabilities={probabilities}
              onToggle={toggle}
              onWeightChange={(id, w) => onChange(setBuildWeight(config, id, w))}
              emptyHint="No custom builds yet for this matchup."
            />
          </Section>
        </>
      )}

      <BuildUnitRollEditor
        matchup={matchup}
        config={config}
        onChange={onChange}
      />
    </div>
  );
}

function MatchupHeader({ matchup }: { matchup: MatchupKey }) {
  const { my, vs } = matchupRaces(matchup);
  const tint = raceTint(my);
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <RaceIcon race={my} size={22} />
        <span className="text-caption font-bold text-text-muted">vs</span>
        <RaceIcon race={vs} size={22} />
      </div>
      <h2 className={["text-display-sm font-bold", tint.text].join(" ")}>
        {matchup}
      </h2>
    </div>
  );
}

function BuildChecklist({
  candidates,
  selectedIds,
  config,
  probabilities,
  onToggle,
  onWeightChange,
  emptyHint,
}: {
  candidates: PoolCandidate[];
  selectedIds: Set<string>;
  config: MatchupConfig;
  probabilities: number[];
  onToggle: (c: PoolCandidate, on: boolean) => void;
  onWeightChange: (id: string, weight: number) => void;
  emptyHint: string;
}) {
  if (candidates.length === 0) {
    return (
      <Card>
        <p className="px-2 py-3 text-caption text-text-muted">{emptyHint}</p>
      </Card>
    );
  }
  // Map id → probability so each row can read its share without
  // re-running normalize per row.
  const probByIndex = new Map<string, number>();
  config.builds.forEach((b, i) => probByIndex.set(b.id, probabilities[i] ?? 0));

  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {candidates.map((c) => {
          const selected = selectedIds.has(c.id);
          const build = config.builds.find((b) => b.id === c.id);
          const probability = probByIndex.get(c.id) ?? 0;
          return (
            <li
              key={c.id}
              className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <label className="flex flex-1 min-w-0 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) => onToggle(c, e.target.checked)}
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-accent-cyan"
                  aria-label={`Toggle ${c.name}`}
                />
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <RaceIcon race={c.race} size={20} />
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-text">
                      {c.name}
                    </span>
                    <span className="mt-0.5 inline-flex items-center gap-2">
                      <Badge
                        variant={c.source === "catalog" ? "cyan" : "warning"}
                        size="sm"
                      >
                        {c.source}
                      </Badge>
                      {selected && config.enabled ? (
                        <span className="text-caption tabular-nums text-text-muted">
                          {(probability * 100).toFixed(1)}%
                        </span>
                      ) : null}
                    </span>
                  </span>
                </span>
              </label>
              {selected && config.enabled && config.useCustomWeights ? (
                <WeightSlider
                  buildName={c.name}
                  value={build?.weight ?? 1}
                  probability={probability}
                  onChange={(v) => onWeightChange(c.id, v)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function WeightSlider({
  buildName,
  value,
  probability,
  onChange,
}: {
  buildName: string;
  value: number;
  probability: number;
  onChange: (next: number) => void;
}) {
  const pct = (probability * 100).toFixed(1);
  return (
    <div className="flex flex-shrink-0 items-center gap-2 sm:w-56">
      <input
        type="range"
        min={0}
        max={10}
        step={0.1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`Selection weight for build ${buildName}`}
        aria-valuetext={`${value.toFixed(1)} weight, ${pct} percent selection chance`}
        className="h-1 flex-1 cursor-pointer accent-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="w-10 flex-shrink-0 text-right text-caption tabular-nums text-text">
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={[
        "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-text">{title}</span>
        <span className="mt-0.5 block text-caption text-text-muted">
          {description}
        </span>
      </span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </label>
  );
}
