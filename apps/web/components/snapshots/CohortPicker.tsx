"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { tierLabel, type SnapshotScope } from "./shared/snapshotTypes";

// Sticky cohort filter rail. Six controls:
//   - Build (text or "*" for "all my builds")
//   - Matchup picker (9 race-vs-race options)
//   - Opening picker (free text — opponent.opening from the data)
//   - MMR bucket (200-MMR buckets; "any" disables the filter)
//   - Map (optional split; cohort falls back one tier on empty hit)
//   - Scope (mine | community | both)
//
// The picker emits an onChange whenever the user adjusts a control;
// the parent page is responsible for refetching. The cohort tier
// badge surfaces the currently-resolved tier so the user sees how
// specific their comparison is at a glance.

export interface CohortPickerValue {
  build?: string;
  matchup?: string;
  oppOpening?: string;
  mmrBucket?: number;
  mapId?: string;
  scope: SnapshotScope;
}

export interface CohortPickerProps {
  value: CohortPickerValue;
  onChange: (next: CohortPickerValue) => void;
  cohortTier?: number;
  sampleSize?: number;
  availableBuilds?: string[];
  availableMatchups?: string[];
}

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];
const MMR_BUCKETS = [
  { label: "Any MMR", value: undefined },
  { label: "Bronze (≤2200)", value: 2000 },
  { label: "Silver (2200–2600)", value: 2200 },
  { label: "Gold (2600–3000)", value: 2600 },
  { label: "Platinum (3000–3400)", value: 3000 },
  { label: "Diamond (3400–4000)", value: 3400 },
  { label: "Master (4000–5000)", value: 4000 },
  { label: "GM (5000+)", value: 5000 },
];

export function CohortPicker({
  value,
  onChange,
  cohortTier,
  sampleSize,
  availableBuilds = [],
  availableMatchups = MATCHUPS,
}: CohortPickerProps) {
  const [openingDraft, setOpeningDraft] = useState(value.oppOpening || "");
  useEffect(() => setOpeningDraft(value.oppOpening || ""), [value.oppOpening]);

  function update<K extends keyof CohortPickerValue>(key: K, v: CohortPickerValue[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <Card variant="elevated">
      <Card.Header>
        <h2 className="text-caption font-semibold text-text">Cohort</h2>
        {typeof cohortTier === "number" ? (
          <span
            className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent"
            aria-label={`Cohort ${tierLabel(cohortTier)} with ${sampleSize} games`}
          >
            {tierLabel(cohortTier)} · {sampleSize ?? 0} games
          </span>
        ) : null}
      </Card.Header>
      <Card.Body className="space-y-3">
        <Field label="Build">
          <select
            className="input"
            value={value.build || ""}
            onChange={(e) => update("build", e.target.value || undefined)}
          >
            <option value="">All builds</option>
            {availableBuilds.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Matchup">
          <select
            className="input"
            value={value.matchup || ""}
            onChange={(e) => update("matchup", e.target.value || undefined)}
          >
            <option value="">Any matchup</option>
            {availableMatchups.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Opponent opening">
          <input
            type="text"
            className="input"
            placeholder="Any opening"
            value={openingDraft}
            onChange={(e) => setOpeningDraft(e.target.value)}
            onBlur={() => update("oppOpening", openingDraft.trim() || undefined)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                update("oppOpening", openingDraft.trim() || undefined);
              }
            }}
          />
        </Field>

        <Field label="MMR bucket">
          <select
            className="input"
            value={value.mmrBucket ?? ""}
            onChange={(e) =>
              update(
                "mmrBucket",
                e.target.value === "" ? undefined : Number(e.target.value),
              )
            }
          >
            {MMR_BUCKETS.map((b) => (
              <option key={String(b.value)} value={b.value ?? ""}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Scope">
          <div className="flex gap-1 rounded-lg border border-border bg-bg-elevated p-0.5">
            {(["mine", "community", "both"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={value.scope === s}
                onClick={() => update("scope", s)}
                className={[
                  "flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium capitalize",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  value.scope === s
                    ? "bg-accent text-white"
                    : "text-text-muted hover:text-text",
                ].join(" ")}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>
      </Card.Body>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </span>
      {children}
    </label>
  );
}
