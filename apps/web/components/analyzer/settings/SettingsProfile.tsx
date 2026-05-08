"use client";

import { useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  HelpCircle,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { usePublishDirty } from "./SettingsContext";

type ProfileRead = {
  battleTag?: string;
  // Legacy single-string field. Mirrored from pulseIds[0] by the API
  // so older clients keep working; we don't read it directly here.
  pulseId?: string;
  pulseIds?: string[];
  // Toon handles the API derived from the user's uploaded games that
  // aren't already in pulseIds. Surfaced as one-click suggestions.
  detectedPulseIds?: string[];
  region?: string;
  preferredRace?: string;
  displayName?: string;
};

// What we send back on PUT. Drop the read-only detectedPulseIds.
type ProfileWrite = Omit<ProfileRead, "detectedPulseIds" | "pulseId">;

type Draft = ProfileWrite & { pulseIds: string[] };

const DEFAULT_DRAFT: Draft = { pulseIds: [] };

const REGIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Auto-detect" },
  { value: "us", label: "us — Americas" },
  { value: "eu", label: "eu — Europe" },
  { value: "kr", label: "kr — Korea" },
  { value: "cn", label: "cn — China" },
];

const RACES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "No preference" },
  { value: "Terran", label: "Terran" },
  { value: "Zerg", label: "Zerg" },
  { value: "Protoss", label: "Protoss" },
  { value: "Random", label: "Random" },
];

const PULSE_ID_CAP = 20;

// Two valid shapes:
//   - A numeric SC2Pulse character id, e.g. "994428"
//   - A sc2reader toon handle, e.g. "1-S2-1-267727" (region-S<season>-realm-id)
const NUMERIC_RE = /^[0-9]{1,12}$/;
const TOON_RE = /^[1-9]-S\d+-\d+-\d+$/i;

function isNumericPulseId(raw: string): boolean {
  return NUMERIC_RE.test(raw);
}
function isToonHandle(raw: string): boolean {
  return TOON_RE.test(raw);
}
function classifyPulseId(raw: string): "pulse" | "toon" | "invalid" {
  if (isNumericPulseId(raw)) return "pulse";
  if (isToonHandle(raw)) return "toon";
  return "invalid";
}

function toDraft(read: ProfileRead | undefined): Draft {
  if (!read) return DEFAULT_DRAFT;
  return {
    battleTag: read.battleTag,
    pulseIds: Array.isArray(read.pulseIds) ? read.pulseIds : [],
    region: read.region,
    preferredRace: read.preferredRace,
    displayName: read.displayName,
  };
}

export function SettingsProfile() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<ProfileRead>("/v1/me/profile");
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const serverDraft = useMemo(() => toDraft(data), [data]);
  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<Draft>(
    serverDraft,
    DEFAULT_DRAFT,
  );

  usePublishDirty("profile", dirty);

  // Detected suggestions are server-side and aren't part of the dirty
  // baseline — they live alongside the form but never count as edits.
  const detected = useMemo(() => {
    const known = new Set(draft.pulseIds);
    return (data?.detectedPulseIds ?? []).filter((id) => !known.has(id));
  }, [data?.detectedPulseIds, draft.pulseIds]);

  async function save() {
    if (saving) return;
    setSaving(true);
    const previous = data;
    try {
      const body: ProfileWrite = {
        battleTag: draft.battleTag,
        pulseIds: draft.pulseIds,
        region: draft.region,
        preferredRace: draft.preferredRace,
        displayName: draft.displayName,
      };
      await mutate({ ...(data ?? {}), ...body }, { revalidate: false });
      await apiCall(getToken, "/v1/me/profile", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await mutate();
      markSaved();
      toast.success("Profile saved");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't save profile", { description: message });
    } finally {
      setSaving(false);
    }
  }

  function addPulseId(raw: string): { ok: boolean; reason?: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: "Enter a Pulse ID first." };
    if (classifyPulseId(trimmed) === "invalid") {
      return {
        ok: false,
        reason:
          "Use a numeric SC2Pulse character id (e.g. 994428) or a toon handle (e.g. 1-S2-1-267727).",
      };
    }
    if (draft.pulseIds.includes(trimmed)) {
      return { ok: false, reason: "Already in your list." };
    }
    if (draft.pulseIds.length >= PULSE_ID_CAP) {
      return { ok: false, reason: `Up to ${PULSE_ID_CAP} Pulse IDs.` };
    }
    setDraft((d) => ({ ...d, pulseIds: [...d.pulseIds, trimmed] }));
    return { ok: true };
  }

  function removePulseId(id: string) {
    setDraft((d) => ({
      ...d,
      pulseIds: d.pulseIds.filter((x) => x !== id),
    }));
  }

  function addAllDetected() {
    if (detected.length === 0) return;
    setDraft((d) => {
      const seen = new Set(d.pulseIds);
      const merged = [...d.pulseIds];
      for (const id of detected) {
        if (seen.has(id)) continue;
        if (merged.length >= PULSE_ID_CAP) break;
        merged.push(id);
        seen.add(id);
      }
      return { ...d, pulseIds: merged };
    });
  }

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <>
      <Section
        title="Profile"
        description="How you appear in your dashboard and overlay cards. BattleTag and Pulse IDs let us link cloud games to your in-game identity."
      >
        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Display name"
              hint="Shown in overlays and shareable build links"
            >
              <Input
                value={draft.displayName ?? ""}
                placeholder="Your name"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, displayName: e.target.value }))
                }
              />
            </Field>
            <Field label="BattleTag" hint="e.g. PlayerName#1234">
              <Input
                value={draft.battleTag ?? ""}
                placeholder="Name#1234"
                autoComplete="off"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, battleTag: e.target.value }))
                }
              />
            </Field>
            <Field label="Region" hint="Battle.net region used for ladder lookups">
              <Select
                value={draft.region ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, region: e.target.value }))
                }
              >
                {REGIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Preferred race"
              hint="Defaults the analyzer view to this matchup"
            >
              <Select
                value={draft.preferredRace ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, preferredRace: e.target.value }))
                }
              >
                {RACES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </Section>

      <Section
        title="Pulse IDs"
        description="Add every SC2Pulse identity you play on. Multi-region streamers usually have one per region; the agent auto-detects new ones from your replays."
      >
        <Card>
          <PulseIdEditor
            ids={draft.pulseIds}
            detected={detected}
            onAdd={addPulseId}
            onRemove={removePulseId}
            onAddAllDetected={addAllDetected}
          />
        </Card>
      </Section>

      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
    </>
  );
}

interface PulseIdEditorProps {
  ids: string[];
  detected: string[];
  onAdd: (raw: string) => { ok: boolean; reason?: string };
  onRemove: (id: string) => void;
  onAddAllDetected: () => void;
}

function PulseIdEditor({
  ids,
  detected,
  onAdd,
  onRemove,
  onAddAllDetected,
}: PulseIdEditorProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const liveClass =
    trimmed.length === 0 ? "idle" : classifyPulseId(trimmed);
  const atCap = ids.length >= PULSE_ID_CAP;
  const canAdd = !atCap && trimmed.length > 0 && liveClass !== "invalid";

  function handleAdd() {
    const result = onAdd(value);
    if (result.ok) {
      setValue("");
      setError(null);
      inputRef.current?.focus();
    } else {
      setError(result.reason ?? "Couldn't add that.");
    }
  }

  return (
    <div className="space-y-4">
      {/* Header row: count + help link */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-caption text-text-dim">
          {ids.length === 0
            ? "No Pulse IDs yet."
            : `${ids.length} of ${PULSE_ID_CAP} Pulse ID${ids.length === 1 ? "" : "s"} saved.`}
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-expanded={helpOpen}
          aria-controls="pulse-id-help"
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden />
          How do I find my Pulse ID?
        </button>
      </div>

      {/* Help panel — collapsed by default */}
      {helpOpen ? <PulseIdHelp /> : null}

      {/* Saved chips */}
      {ids.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Saved Pulse IDs">
          {ids.map((id) => (
            <PulseIdChip key={id} id={id} onRemove={() => onRemove(id)} />
          ))}
        </ul>
      ) : null}

      {/* Add row */}
      <Field
        label={ids.length === 0 ? "Add your first Pulse ID" : "Add another Pulse ID"}
        hint="Numeric SC2Pulse id (e.g. 994428) or toon handle (e.g. 1-S2-1-267727)"
        error={error || undefined}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            value={value}
            placeholder="994428 or 1-S2-1-267727"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            invalid={trimmed.length > 0 && liveClass === "invalid"}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            disabled={atCap}
          />
          <Button
            type="button"
            variant="secondary"
            iconLeft={<Plus className="h-4 w-4" aria-hidden />}
            onClick={handleAdd}
            disabled={!canAdd}
          >
            Add
          </Button>
        </div>
      </Field>

      {/* Detected suggestions */}
      {detected.length > 0 ? (
        <DetectedSuggestions
          detected={detected}
          atCap={atCap}
          onAdd={onAdd}
          onAddAll={onAddAllDetected}
        />
      ) : null}
    </div>
  );
}

function PulseIdChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const kind = classifyPulseId(id);
  const isToon = kind === "toon";
  const sc2pulseHref = !isToon
    ? `https://sc2pulse.nephest.com/sc2/?type=character&id=${encodeURIComponent(id)}&m=1#player-stats-mmr`
    : null;
  return (
    <li className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-bg-elevated py-1 pl-3 pr-1.5 text-caption text-text">
      <span className="truncate font-mono">{id}</span>
      <Badge variant={isToon ? "neutral" : "accent"} size="sm">
        {isToon ? "toon" : "pulse"}
      </Badge>
      {sc2pulseHref ? (
        <a
          href={sc2pulseHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`Open ${id} on sc2pulse.nephest.com`}
          title="Open on sc2pulse.nephest.com"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-dim hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
        aria-label={`Remove ${id}`}
        title="Remove"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  );
}

function DetectedSuggestions({
  detected,
  atCap,
  onAdd,
  onAddAll,
}: {
  detected: string[];
  atCap: boolean;
  onAdd: (raw: string) => { ok: boolean; reason?: string };
  onAddAll: () => void;
}) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 text-caption font-medium text-accent">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Detected from your replays ({detected.length})
        </div>
        {detected.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onAddAll}
            disabled={atCap}
          >
            Add all
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-caption text-text-dim">
        These are toon handles the agent saw in your uploaded games. Add the
        ones that are yours and we'll use them for MMR lookups and overlays.
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {detected.map((id) => (
          <li
            key={id}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-bg-elevated py-1 pl-3 pr-1.5 text-caption text-text"
          >
            <span className="truncate font-mono">{id}</span>
            <button
              type="button"
              onClick={() => onAdd(id)}
              disabled={atCap}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-accent/15 px-2 text-[11px] font-semibold text-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`Add ${id}`}
            >
              <Plus className="h-3 w-3" aria-hidden />
              Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PulseIdHelp() {
  return (
    <div
      id="pulse-id-help"
      className="rounded-lg border border-border bg-bg-subtle p-4 text-caption text-text"
    >
      <p className="mb-2 font-medium">Two ways to find your Pulse ID</p>
      <ol className="ml-4 list-decimal space-y-2 text-text-dim">
        <li>
          <span className="font-medium text-text">From SC2Pulse</span> (recommended)
          <ol className="ml-4 mt-1 list-[lower-alpha] space-y-1">
            <li>
              Open{" "}
              <a
                href="https://sc2pulse.nephest.com/sc2/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                sc2pulse.nephest.com
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>{" "}
              and search your BattleTag.
            </li>
            <li>Click your character. Your URL will look like:</li>
            <li className="ml-2 break-all rounded bg-bg-elevated px-2 py-1 font-mono text-[11px] text-text">
              sc2pulse.nephest.com/sc2/?type=character&id=<span className="text-accent">994428</span>
            </li>
            <li>
              The number after <span className="font-mono">id=</span> is your
              Pulse ID. Paste it above.
            </li>
          </ol>
        </li>
        <li>
          <span className="font-medium text-text">Auto-detect</span> — leave
          this empty and play one ranked or unranked game with the agent
          running. Your toon handle will appear under "Detected from your
          replays" within seconds of the upload, ready to one-click add.
        </li>
      </ol>
      <p className="mt-3 text-text-dim">
        Multiple regions? Add one ID per region. The session widget picks the
        most recent identity automatically.
      </p>
    </div>
  );
}
