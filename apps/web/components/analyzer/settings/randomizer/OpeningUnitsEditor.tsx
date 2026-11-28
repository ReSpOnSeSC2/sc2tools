"use client";

/**
 * One opening-unit draw's settings: how many units, equal or custom odds,
 * and which units. The same editor serves a matchup's own unit draw and
 * each build's, so both read and behave alike.
 */
import { Icon } from "@/components/ui/Icon";
import { Toggle } from "@/components/ui/Toggle";
import { withUnitSelected, withUnitWeight } from "@/lib/randomizer/config";
import { normalizeProbabilities } from "@/lib/randomizer/engine";
import { openingUnitMeta } from "@/lib/randomizer/openingUnits";
import {
  OPENING_UNIT_IDS,
  type GatewayCount,
  type OpeningUnitId,
  type OpeningUnitsConfig,
  type PlayedRace,
} from "@/lib/randomizer/types";

export interface OpeningUnitsEditorProps {
  /** Unique, DOM-safe prefix for this editor's control ids. */
  idPrefix: string;
  /** What the settings belong to, for accessible names ("TvZ", a build). */
  subject: string;
  race: PlayedRace;
  /** The units the matchup offers, in canonical order. */
  eligible: readonly OpeningUnitId[];
  value: OpeningUnitsConfig;
  onChange: (next: OpeningUnitsConfig) => void;
}

export function OpeningUnitsEditor(props: OpeningUnitsEditorProps) {
  const { value, onChange, subject, idPrefix } = props;
  return (
    <div className="space-y-4">
      <CountControl {...props} />
      <label htmlFor={`${idPrefix}-custom-odds`} className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-text">Use custom unit odds</span>
          <span className="mt-0.5 block text-caption text-text-muted">
            Off gives every selected unit an equal chance.
          </span>
        </span>
        <Toggle
          id={`${idPrefix}-custom-odds`}
          checked={value.useCustomWeights}
          onChange={(useCustomWeights) => onChange({ ...value, useCustomWeights })}
          label={`Use custom opening-unit odds for ${subject}`}
        />
      </label>
      <UnitList {...props} />
    </div>
  );
}

function countLabel(race: PlayedRace, count: GatewayCount): string {
  if (race === "Protoss") return `${count} Gate${count === 2 ? "s" : ""}`;
  return count === 2 ? "2 units" : "1 unit";
}

function CountControl({ idPrefix, subject, race, value, onChange }: OpeningUnitsEditorProps) {
  return (
    <fieldset>
      <legend className="text-caption font-semibold text-text">How many to draw</legend>
      <p className="mt-0.5 text-caption text-text-muted">
        {race === "Protoss"
          ? "One unit per Gateway in the opening."
          : "One unit, or two for an opener built on two buildings."}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup">
        {([1, 2] as const).map((count) => (
          <label key={count} className="cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-count`}
              value={count}
              checked={value.gateCount === count}
              onChange={() => onChange({ ...value, gateCount: count })}
              className="peer sr-only"
              aria-label={`${countLabel(race, count)} for ${subject}`}
            />
            <span className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 text-caption font-semibold text-text transition-colors hover:border-border-strong peer-checked:border-accent-cyan peer-checked:bg-accent-cyan/10 peer-checked:text-accent-cyan peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg">
              {race === "Protoss" ? (
                <span className="flex items-center -space-x-1" aria-hidden>
                  {Array.from({ length: count }).map((_, index) => (
                    <Icon key={index} name="Gateway" kind="building" size={22} decorative />
                  ))}
                </span>
              ) : null}
              {countLabel(race, count)}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-micro text-text-muted">
        {value.gateCount === 1
          ? "Draws one opening unit."
          : "Draws twice from these odds. Picks are independent, so repeats are possible."}
      </p>
    </fieldset>
  );
}

/** The matchup's units, plus any still selected from before, in canonical order. */
function listedUnits(race: PlayedRace, eligible: readonly OpeningUnitId[], value: OpeningUnitsConfig): OpeningUnitId[] {
  const shown = new Set<OpeningUnitId>([...eligible, ...value.units.map((unit) => unit.id)]);
  return OPENING_UNIT_IDS[race].filter((id) => shown.has(id));
}

function UnitList({ idPrefix, subject, race, eligible, value, onChange }: OpeningUnitsEditorProps) {
  const hintId = `${idPrefix}-units-hint`;
  const selected = new Map(value.units.map((unit) => [unit.id, unit]));
  const probabilities = normalizeProbabilities(value.units.map((unit) => (value.useCustomWeights ? unit.weight : 1)));
  const chance = new Map(value.units.map((unit, index) => [unit.id, probabilities[index] ?? 0]));

  function changeWeight(unitId: OpeningUnitId, weight: number) {
    // Never let the last positive weight reach zero: the odds would no longer say anything.
    const others = value.units.reduce((sum, unit) => (unit.id === unitId ? sum : sum + Math.max(0, unit.weight)), 0);
    onChange(withUnitWeight(value, unitId, weight <= 0 && others <= 0 ? 0.1 : weight));
  }

  return (
    <fieldset>
      <legend className="text-caption font-semibold text-text">Units</legend>
      <p id={hintId} className="mt-0.5 text-caption text-text-muted">
        Keep at least one selected. Each chance is the final share of a draw.
      </p>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-surface">
        {listedUnits(race, eligible, value).map((id) => (
          <UnitRow
            key={id}
            id={id}
            subject={subject}
            hintId={hintId}
            weight={selected.get(id)?.weight ?? null}
            chance={chance.get(id) ?? 0}
            lastSelected={selected.has(id) && value.units.length === 1}
            customOdds={value.useCustomWeights}
            onToggle={(on) => onChange(withUnitSelected(value, race, id, on))}
            onWeight={(weight) => changeWeight(id, weight)}
          />
        ))}
      </ul>
    </fieldset>
  );
}

function UnitRow({
  id, subject, hintId, weight, chance, lastSelected, customOdds, onToggle, onWeight,
}: {
  id: OpeningUnitId;
  subject: string;
  hintId: string;
  /** Null when the unit is not selected. */
  weight: number | null;
  chance: number;
  lastSelected: boolean;
  customOdds: boolean;
  onToggle: (on: boolean) => void;
  onWeight: (weight: number) => void;
}) {
  const unit = openingUnitMeta(id);
  const pct = (chance * 100).toFixed(1);
  return (
    <li className="flex min-h-[58px] flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={weight !== null}
          disabled={lastSelected}
          aria-describedby={hintId}
          aria-label={`Include ${unit.name} in the opening draw for ${subject}`}
          onChange={(event) => onToggle(event.target.checked)}
          className="h-5 w-5 flex-shrink-0 cursor-pointer accent-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
        />
        <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-bg-elevated">
          <Icon name={unit.name} kind="unit" size={32} decorative />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-text">{unit.name}</span>
          <span className="block text-caption tabular-nums text-text-muted">
            {weight !== null ? `${pct}% chance · ${unit.building}` : `Not drawn · ${unit.building}`}
          </span>
        </span>
      </label>
      {weight !== null && customOdds ? (
        <div className="flex w-full flex-shrink-0 items-center gap-2 sm:w-64">
          <input
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={weight}
            onChange={(event) => onWeight(Number(event.target.value))}
            aria-label={`Selection weight for ${unit.name} in ${subject}`}
            aria-valuetext={`${weight.toFixed(1)} weight, ${pct} percent selection chance`}
            className="h-1 flex-1 cursor-pointer accent-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span className="w-10 flex-shrink-0 text-right text-caption tabular-nums text-text">{weight.toFixed(1)}</span>
          <span className="w-14 flex-shrink-0 text-right text-caption tabular-nums text-accent-cyan">{pct}%</span>
        </div>
      ) : null}
    </li>
  );
}
