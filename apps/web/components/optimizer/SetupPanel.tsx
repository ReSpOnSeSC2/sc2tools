"use client";

/**
 * Matchup, objective, and patch-profile configuration for the
 * optimizer. Race pickers reuse the shared race tint chrome so the
 * matchup reads the same as everywhere else in the app.
 */
import { Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { Icon } from "@/components/ui/Icon";
import { raceTint } from "@/lib/race";
import { OBJECTIVES } from "@/lib/optimizer/search/objectives";
import type { ProfileSummary } from "@/lib/optimizer/patch/profiles";
import type { SimRace } from "@/lib/optimizer/types";
import { formatBuildTime } from "@/lib/build-events";
import type { OptimizerSettings } from "./OptimizerClient";

const SIM_RACES: SimRace[] = ["Protoss", "Terran", "Zerg"];

function RacePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SimRace;
  onChange: (race: SimRace) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex gap-2" role="radiogroup" aria-label={label}>
        {SIM_RACES.map((race) => {
          const tint = raceTint(race);
          const selected = race === value;
          return (
            <button
              key={race}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(race)}
              className={[
                "relative flex flex-1 items-center justify-center gap-1.5 rounded-lg border-2 px-2 py-2 text-caption transition-colors",
                // Selected wears the bold ink outline + race tint + check;
                // unselected stays visually quiet (faint border, muted text)
                // so the highlighted option is unambiguous.
                selected
                  ? `border-line shadow-hard font-semibold ${tint.bg} ${tint.text}`
                  : "border-line/25 bg-bg-surface font-medium text-text-dim opacity-60 hover:opacity-100 hover:border-line/60 hover:text-text-muted",
              ].join(" ")}
            >
              <Icon name={race.toLowerCase()} kind="race" size="sm" decorative />
              {race}
              {selected ? (
                <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={3} />
              ) : null}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

export function SetupPanel({
  settings,
  profiles,
  onChange,
}: {
  settings: OptimizerSettings;
  profiles: ProfileSummary[];
  onChange: (patch: Partial<OptimizerSettings>) => void;
}) {
  const objective = OBJECTIVES.find((o) => o.id === settings.objectiveId);
  return (
    <Card title="Setup">
      <div className="space-y-4 p-4">
        <RacePicker
          label="Your race"
          value={settings.race}
          onChange={(race) => onChange({ race })}
        />
        <RacePicker
          label="Opponent race"
          value={settings.vsRace}
          onChange={(vsRace) => onChange({ vsRace })}
        />
        <Field
          label="Objective"
          hint={objective?.description}
        >
          <Select
            value={settings.objectiveId}
            onChange={(e) =>
              onChange({
                objectiveId: e.target.value as OptimizerSettings["objectiveId"],
              })
            }
          >
            {OBJECTIVES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {objective?.usesAtSec ? (
          <Field
            label="Target time (seconds)"
            hint={`Evaluated at ${formatBuildTime(settings.objectiveAtSec)}`}
          >
            <Input
              type="number"
              min={120}
              max={900}
              step={10}
              value={settings.objectiveAtSec}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) {
                  onChange({
                    objectiveAtSec: Math.min(900, Math.max(120, next)),
                  });
                }
              }}
            />
          </Field>
        ) : null}
        <Field
          label="Balance patch"
          hint="All costs, timings, and economy constants come from this profile. New patches are added as data files."
        >
          <Select
            value={settings.profileId}
            onChange={(e) => onChange({ profileId: e.target.value })}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-text">
              I will wall off
              <span className="block text-caption text-text-dim">
                Boosts defense vs melee-only attacks (lings, zealots)
              </span>
            </span>
            <Toggle
              checked={settings.hasWall}
              onChange={(hasWall) => onChange({ hasWall })}
              label="I will wall off"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-text">
              Worker pull allowed
              <span className="block text-caption text-text-dim">
                Counts a defensive worker pull where the threat allows it
              </span>
            </span>
            <Toggle
              checked={settings.allowWorkerPull}
              onChange={(allowWorkerPull) => onChange({ allowWorkerPull })}
              label="Worker pull allowed"
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
