"use client";

/**
 * Threat editor — tune a shipped threat (timings shift as the meta
 * settles on a new patch) or add a brand-new one. Edits persist to
 * the localStorage overlay; shipped entries are never destroyed,
 * only overridden, so "Reset" always recovers the curated catalog.
 *
 * Waves use a compact line format ("2:05 Zergling x6, Roach x2");
 * scouting tells are edited as JSON for full fidelity.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { formatBuildTime } from "@/lib/build-events";
import {
  setThreatDisabled,
  upsertThreat,
  validateThreat,
  type ThreatOverlay,
} from "@/lib/optimizer/threats/store";
import type {
  ScoutingTell,
  SimRace,
  Threat,
  ThreatWave,
} from "@/lib/optimizer/types";

const SIM_RACES: SimRace[] = ["Protoss", "Terran", "Zerg"];

function parseTime(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d+):([0-5]?\d)$/.exec(trimmed);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function wavesToText(waves: ThreatWave[]): string {
  return waves
    .map((wave) => {
      const units = Object.entries(wave.units)
        .map(([name, count]) => `${name} x${count}`)
        .join(", ");
      return `${formatBuildTime(wave.timeSec)} ${units}`;
    })
    .join("\n");
}

function parseWaves(text: string): { waves: ThreatWave[]; error?: string } {
  const waves: ThreatWave[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [timePart, ...rest] = line.split(/\s+/);
    const timeSec = parseTime(timePart);
    if (timeSec === null) {
      return { waves, error: `Bad time in "${line}" — use m:ss or seconds.` };
    }
    const unitsText = rest.join(" ");
    const units: Record<string, number> = {};
    for (const chunk of unitsText.split(",")) {
      const entry = chunk.trim();
      if (!entry) continue;
      const match = /^([A-Za-z]+)\s*x\s*(\d+)$/.exec(entry);
      if (!match) {
        return {
          waves,
          error: `Bad unit entry "${entry}" — use "Zergling x6".`,
        };
      }
      units[match[1]] = Number(match[2]);
    }
    if (Object.keys(units).length === 0) {
      return { waves, error: `Wave "${line}" has no units.` };
    }
    waves.push({ timeSec, units });
  }
  return { waves };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "custom-threat"
  );
}

interface EditorState {
  name: string;
  description: string;
  attackerRace: SimRace;
  arrival: string;
  prior: string;
  wavesText: string;
  tellsJson: string;
  wallRecommended: boolean;
  workerPullViable: boolean;
}

function stateFromThreat(threat: Threat | null, defenderRace: SimRace): EditorState {
  if (!threat) {
    return {
      name: "",
      description: "",
      attackerRace: defenderRace === "Zerg" ? "Terran" : "Zerg",
      arrival: "2:30",
      prior: "0.1",
      wavesText: "2:30 Zergling x6",
      tellsJson: "[]",
      wallRecommended: false,
      workerPullViable: false,
    };
  }
  return {
    name: threat.name,
    description: threat.description,
    attackerRace: threat.attackerRace,
    arrival: formatBuildTime(threat.earliestArrivalSec),
    prior: String(threat.priorProbability),
    wavesText: wavesToText(threat.waves),
    tellsJson: JSON.stringify(threat.scoutingTells, null, 2),
    wallRecommended: Boolean(threat.defenderHints.wallRecommended),
    workerPullViable: Boolean(threat.defenderHints.workerPullViable),
  };
}

export function ThreatEditorModal({
  open,
  threat,
  isShipped,
  defenderRace,
  overlay,
  onClose,
  onSave,
}: {
  open: boolean;
  threat: Threat | null;
  isShipped: boolean;
  defenderRace: SimRace;
  overlay: ThreatOverlay;
  onClose: () => void;
  onSave: (next: ThreatOverlay) => void;
}) {
  const [state, setState] = useState<EditorState>(() =>
    stateFromThreat(threat, defenderRace),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setState(stateFromThreat(threat, defenderRace));
      setError(null);
    }
  }, [open, threat, defenderRace]);

  const isDisabled = threat ? overlay.disabled.includes(threat.id) : false;

  const handleSave = () => {
    const arrival = parseTime(state.arrival);
    if (arrival === null) {
      setError("Earliest arrival must be m:ss or seconds.");
      return;
    }
    const prior = Number(state.prior);
    const parsedWaves = parseWaves(state.wavesText);
    if (parsedWaves.error) {
      setError(parsedWaves.error);
      return;
    }
    let tells: ScoutingTell[];
    try {
      const parsed: unknown = JSON.parse(state.tellsJson);
      if (!Array.isArray(parsed)) throw new Error("must be an array");
      tells = parsed as ScoutingTell[];
    } catch (e) {
      setError(
        `Scouting tells JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    const next: Threat = {
      id: threat?.id ?? slugify(state.name),
      attackerRace: state.attackerRace,
      vsDefender: threat?.vsDefender ?? ["Protoss", "Terran", "Zerg"],
      name: state.name.trim(),
      description: state.description.trim(),
      earliestArrivalSec: arrival,
      priorProbability: prior,
      scoutingTells: tells,
      waves: parsedWaves.waves,
      dangerWindows: threat?.dangerWindows ?? [],
      defenderHints: {
        wallRecommended: state.wallRecommended,
        workerPullViable: state.workerPullViable,
      },
    };
    const problems = validateThreat(next);
    if (problems.length > 0) {
      setError(problems.join(" · "));
      return;
    }
    onSave(upsertThreat(overlay, next, isShipped));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={threat ? `Edit threat: ${threat.name}` : "Add threat"}
      description="Changes are saved on this device and override the shipped catalog."
      size="lg"
      footer={
        <ModalActions className="w-full justify-between">
          <div>
            {threat ? (
              <Button
                variant="ghost"
                onClick={() =>
                  onSave(setThreatDisabled(overlay, threat.id, !isDisabled))
                }
              >
                {isDisabled ? "Re-enable threat" : "Disable threat"}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save threat</Button>
          </div>
        </ModalActions>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            placeholder="12-pool speedling flood"
          />
        </Field>
        <Field label="Description">
          <Input
            value={state.description}
            onChange={(e) =>
              setState({ ...state, description: e.target.value })
            }
            placeholder="What it is and why it kills you"
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Attacker race">
            <Select
              value={state.attackerRace}
              onChange={(e) =>
                setState({
                  ...state,
                  attackerRace: e.target.value as SimRace,
                })
              }
            >
              {SIM_RACES.map((race) => (
                <option key={race} value={race}>
                  {race}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="First hit (m:ss)">
            <Input
              value={state.arrival}
              onChange={(e) => setState({ ...state, arrival: e.target.value })}
            />
          </Field>
          <Field label="Meta prior (0-1)">
            <Input
              value={state.prior}
              onChange={(e) => setState({ ...state, prior: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="Attack waves"
          hint='One per line: "2:05 Zergling x6, Roach x2" — cumulative pressure over time.'
        >
          <textarea
            className="min-h-[90px] w-full rounded-lg border-2 border-line bg-bg-surface p-2 font-mono text-caption text-text focus:border-accent focus:outline-none"
            value={state.wavesText}
            onChange={(e) => setState({ ...state, wavesText: e.target.value })}
          />
        </Field>
        <Field
          label="Scouting tells (JSON)"
          hint='Entries: { "id", "observation", "weight" 0-1, optional "windowSec": [from,to], optional "contradicts": true }'
        >
          <textarea
            className="min-h-[120px] w-full rounded-lg border-2 border-line bg-bg-surface p-2 font-mono text-caption text-text focus:border-accent focus:outline-none"
            value={state.tellsJson}
            onChange={(e) => setState({ ...state, tellsJson: e.target.value })}
          />
        </Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-caption text-text">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[rgb(var(--accent))]"
              checked={state.wallRecommended}
              onChange={(e) =>
                setState({ ...state, wallRecommended: e.target.checked })
              }
            />
            Wall-off helps
          </label>
          <label className="flex items-center gap-2 text-caption text-text">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[rgb(var(--accent))]"
              checked={state.workerPullViable}
              onChange={(e) =>
                setState({ ...state, workerPullViable: e.target.checked })
              }
            />
            Worker pull viable
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
