"use client";

/**
 * Scouting observation checklist for one threat-set. Each tell from
 * the matchup's threats renders as a checkbox + observation time;
 * checking it feeds the inference engine and live-updates threat
 * probabilities in the panel above.
 */
import { useMemo } from "react";
import { formatBuildTime } from "@/lib/build-events";
import type {
  ScoutingObservation,
  ScoutingTell,
  Threat,
} from "@/lib/optimizer/types";

interface TellRow {
  tell: ScoutingTell;
  threatNames: string[];
}

export function ScoutingInput({
  threats,
  observations,
  onChange,
}: {
  threats: Threat[];
  observations: ScoutingObservation[];
  onChange: (next: ScoutingObservation[]) => void;
}) {
  // The same conceptual tell can appear on several threats; dedupe by
  // id so the checklist stays readable.
  const rows = useMemo<TellRow[]>(() => {
    const byId = new Map<string, TellRow>();
    for (const threat of threats) {
      for (const tell of threat.scoutingTells) {
        const existing = byId.get(tell.id);
        if (existing) {
          existing.threatNames.push(threat.name);
        } else {
          byId.set(tell.id, { tell, threatNames: [threat.name] });
        }
      }
    }
    return [...byId.values()];
  }, [threats]);

  const observed = useMemo(
    () => new Map(observations.map((o) => [o.tellId, o])),
    [observations],
  );

  const toggle = (tell: ScoutingTell) => {
    if (observed.has(tell.id)) {
      onChange(observations.filter((o) => o.tellId !== tell.id));
      return;
    }
    // Default the observation time to the middle of the tell's window
    // (or its start) — the user can refine it with the time input.
    const atSec = tell.windowSec
      ? Math.round((tell.windowSec[0] + tell.windowSec[1]) / 2)
      : 60;
    onChange([...observations, { tellId: tell.id, atSec }]);
  };

  const setTime = (tellId: string, value: string) => {
    const [m, s] = value.split(":").map((part) => Number(part));
    const atSec = Number.isFinite(s) ? m * 60 + s : Number(value);
    if (!Number.isFinite(atSec) || atSec < 0) return;
    onChange(
      observations.map((o) => (o.tellId === tellId ? { ...o, atSec } : o)),
    );
  };

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-caption font-medium text-text">
        What did you scout?
      </div>
      <ul className="space-y-1.5">
        {rows.map(({ tell, threatNames }) => {
          const observation = observed.get(tell.id);
          return (
            <li key={tell.id} className="flex items-start gap-2">
              <input
                id={`tell-${tell.id}`}
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]"
                checked={Boolean(observation)}
                onChange={() => toggle(tell)}
              />
              <label
                htmlFor={`tell-${tell.id}`}
                className="flex-1 cursor-pointer text-caption text-text"
              >
                {tell.observation}
                <span className="block text-caption text-text-dim">
                  {tell.contradicts ? "rules out: " : "points to: "}
                  {threatNames.join(", ")}
                  {tell.windowSec
                    ? ` · window ${formatBuildTime(tell.windowSec[0])}–${formatBuildTime(tell.windowSec[1])}`
                    : ""}
                </span>
              </label>
              {observation ? (
                <input
                  type="text"
                  aria-label={`Time observed for: ${tell.observation}`}
                  className="w-16 rounded-md border-2 border-line bg-bg-surface px-1.5 py-0.5 text-right text-caption text-text focus:border-accent focus:outline-none"
                  defaultValue={formatBuildTime(observation.atSec)}
                  onBlur={(e) => setTime(tell.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTime(tell.id, (e.target as HTMLInputElement).value);
                    }
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
