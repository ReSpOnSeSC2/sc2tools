"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Volume2, Play, Square } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { usePublishDirty } from "./SettingsContext";

type VoicePrefs = {
  enabled: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  events?: { matchStart?: boolean; matchEnd?: boolean; cheese?: boolean };
};

const DEFAULT_PREFS: VoicePrefs = {
  enabled: false,
  rate: 1,
  pitch: 1,
  events: {},
};

const EVENT_KEYS = ["matchStart", "matchEnd", "cheese"] as const;
const EVENT_LABELS: Record<(typeof EVENT_KEYS)[number], string> = {
  matchStart: "Match start",
  matchEnd: "Match end",
  cheese: "Cheese detected",
};

const TEST_PHRASE =
  "Opponent detected. Protoss player TestUser, ranked Diamond, last matchup three wins to one.";

export function SettingsVoice() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<VoicePrefs>(
    "/v1/me/preferences/voice",
  );
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<VoicePrefs>(
    data,
    DEFAULT_PREFS,
  );

  usePublishDirty("voice", dirty);

  // Populate browser voice list
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      setVoices(window.speechSynthesis.getVoices());
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      window.speechSynthesis.cancel();
    };
  }, []);

  async function save() {
    if (saving) return;
    setSaving(true);
    const previous = data;
    try {
      await mutate(draft, { revalidate: false });
      await apiCall(getToken, "/v1/me/preferences/voice", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await mutate();
      markSaved();
      toast.success("Voice preferences saved");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't save voice prefs", { description: message });
    } finally {
      setSaving(false);
    }
  }

  function preview() {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      toast.warning("This browser has no speech synthesis support.");
      return;
    }
    if (previewing) {
      window.speechSynthesis.cancel();
      setPreviewing(false);
      return;
    }
    const utt = new SpeechSynthesisUtterance(TEST_PHRASE);
    utt.rate = draft.rate ?? 1;
    utt.pitch = draft.pitch ?? 1;
    if (draft.voice) {
      const match = voices.find((v) => v.name === draft.voice);
      if (match) utt.voice = match;
    }
    utt.onend = () => setPreviewing(false);
    utt.onerror = () => setPreviewing(false);
    utteranceRef.current = utt;
    setPreviewing(true);
    window.speechSynthesis.speak(utt);
  }

  const groupedVoices = useMemo(() => groupVoices(voices), [voices]);

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <>
      <Section
        title="Voice readout"
        description="Reads opponent name, race, and matchup record aloud through the OBS overlay's Web Speech API. Useful for streamers with low-vision viewers."
      >
        <Card>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
            <div>
              <div className="text-body font-medium text-text">
                Enable voice readout
              </div>
              <div className="text-caption text-text-muted">
                Toggles all voice events on or off without losing your settings.
              </div>
            </div>
            <Toggle
              checked={!!draft.enabled}
              onChange={(on) => setDraft((d) => ({ ...d, enabled: on }))}
              label="Enable voice readout"
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Voice" hint="Browser-installed voices only">
              <Select
                value={draft.voice ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, voice: e.target.value || undefined }))
                }
              >
                <option value="">Default system voice</option>
                {Object.entries(groupedVoices).map(([lang, vs]) => (
                  <optgroup key={lang} label={lang}>
                    {vs.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <RangeSlider
              label="Rate"
              suffix="×"
              min={0.5}
              max={2}
              step={0.1}
              value={draft.rate ?? 1}
              onChange={(rate) => setDraft((d) => ({ ...d, rate }))}
            />
            <RangeSlider
              label="Pitch"
              min={0.5}
              max={2}
              step={0.1}
              value={draft.pitch ?? 1}
              onChange={(pitch) => setDraft((d) => ({ ...d, pitch }))}
            />
            <div className="flex items-end">
              <PreviewButton previewing={previewing} onClick={preview} />
            </div>
          </div>

          <fieldset className="mt-6">
            <legend className="text-caption font-medium uppercase tracking-wider text-text-dim">
              Events to announce
            </legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {EVENT_KEYS.map((k) => (
                <label
                  key={k}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2"
                >
                  <span className="text-caption text-text">{EVENT_LABELS[k]}</span>
                  <Toggle
                    checked={!!draft.events?.[k]}
                    onChange={(on) =>
                      setDraft((d) => ({
                        ...d,
                        events: { ...d.events, [k]: on },
                      }))
                    }
                    label={EVENT_LABELS[k]}
                  />
                </label>
              ))}
            </div>
          </fieldset>
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

function PreviewButton({
  previewing,
  onClick,
}: {
  previewing: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={previewing ? "secondary" : "primary"}
      onClick={onClick}
      iconLeft={
        previewing ? (
          <Square className="h-4 w-4" aria-hidden />
        ) : (
          <Play className="h-4 w-4" aria-hidden />
        )
      }
      className={[
        "relative",
        previewing
          ? "ring-2 ring-accent-cyan/60 shadow-halo-cyan animate-pulse"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {previewing ? (
        <span className="inline-flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-accent-cyan" aria-hidden />
          Stop preview
        </span>
      ) : (
        "Test voice"
      )}
    </Button>
  );
}

function RangeSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <Field
      label={
        <span className="flex items-baseline justify-between gap-2">
          <span>{label}</span>
          <span className="font-mono text-caption text-text-muted">
            {value.toFixed(1)}
            {suffix}
          </span>
        </span>
      }
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 w-full cursor-pointer accent-accent-cyan"
      />
    </Field>
  );
}

function groupVoices(
  voices: SpeechSynthesisVoice[],
): Record<string, SpeechSynthesisVoice[]> {
  const out: Record<string, SpeechSynthesisVoice[]> = {};
  for (const v of voices) {
    const key = v.lang || "Other";
    if (!out[key]) out[key] = [];
    out[key].push(v);
  }
  // Sort buckets by language code, voices alphabetically
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, vs]) => [
        k,
        vs.slice().sort((a, b) => a.name.localeCompare(b.name)),
      ]),
  );
}
