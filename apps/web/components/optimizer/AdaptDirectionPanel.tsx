"use client";

/**
 * Direction + opening-window controls for the build adapter.
 *
 * Direction is auto-detected: real ladder games are 12-worker starts,
 * so sources default to "12-worker baseline → current patch". One tap
 * on the swap arrow reverses it for adapting an 8-worker build back
 * to the 12-worker economy. Both ends stay editable selects so future
 * patch profiles drop in without UI changes.
 */
import { ArrowDownUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import {
  resolveProfile,
  type ProfileSummary,
} from "@/lib/optimizer/patch/profiles";
import type { AdapterSettings } from "./OptimizerClient";

const CUTOFF_OPTIONS: { value: number; label: string }[] = [
  { value: 300, label: "First 5:00 — early opening" },
  { value: 420, label: "First 7:00 — the build's heart (recommended)" },
  { value: 600, label: "First 10:00 — full opening + transitions" },
  { value: 0, label: "Whole game — every production event" },
];

function workersLabel(profileId: string): string {
  try {
    return `${resolveProfile(profileId).starting.workers}-worker start`;
  } catch {
    return "";
  }
}

export function AdaptDirectionPanel({
  settings,
  profiles,
  onChange,
}: {
  settings: AdapterSettings;
  profiles: ProfileSummary[];
  onChange: (patch: Partial<AdapterSettings>) => void;
}) {
  const swap = () =>
    onChange({
      fromProfileId: settings.toProfileId,
      toProfileId: settings.fromProfileId,
    });

  const renderEnd = (
    label: string,
    value: string,
    key: "fromProfileId" | "toProfileId",
  ) => (
    <Field label={label} hint={workersLabel(value)}>
      <Select
        value={value}
        aria-label={label}
        onChange={(e) => {
          const next = e.target.value;
          const other =
            key === "fromProfileId"
              ? settings.toProfileId
              : settings.fromProfileId;
          // Never let both ends point at the same patch — flip the
          // other end to whatever this one was, i.e. an implicit swap.
          onChange(
            next === other
              ? {
                  fromProfileId: settings.toProfileId,
                  toProfileId: settings.fromProfileId,
                }
              : { [key]: next },
          );
        }}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Card title="Adaptation">
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          {renderEnd("Build comes from", settings.fromProfileId, "fromProfileId")}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={swap}
              aria-label="Swap adaptation direction"
              title="Swap direction"
              className="flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-4 py-1.5 text-caption font-medium text-text shadow-hard transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ArrowDownUp aria-hidden className="h-4 w-4" />
              Swap direction
            </button>
          </div>
          {renderEnd("Re-time it for", settings.toProfileId, "toProfileId")}
        </div>
        <Field
          label="Opening window (replays)"
          hint="How much of a game's production gets adapted. Saved builds always use their full step list."
        >
          <Select
            value={String(settings.cutoffSec)}
            aria-label="Opening window"
            onChange={(e) => onChange({ cutoffSec: Number(e.target.value) })}
          >
            {CUTOFF_OPTIONS.map((opt) => (
              <option key={opt.value} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-text">
            Strict worker production
            <span className="block text-caption text-text-dim">
              Never delay a probe/SCV for a structure (the economical
              &ldquo;11 pylon&rdquo; line). Off trades ~50 minerals by
              2:00 for ~9s earlier tech.
            </span>
          </span>
          <Toggle
            checked={settings.strictEconomy}
            onChange={(strictEconomy) => onChange({ strictEconomy })}
            label="Strict worker production"
          />
        </div>
        <p className="text-caption text-text-dim">
          Ladder games are 12-worker starts, so the default direction
          re-times them for the 8-worker economy. Swap to convert an
          8-worker build back. Same structures, same order — only the
          timings move.
        </p>
      </div>
    </Card>
  );
}
