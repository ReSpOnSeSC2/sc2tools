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

/**
 * Voice prefs persisted under ``preferences.voice``. Schema parity
 * with `data/config.schema.json` (`config.voice`):
 *   enabled         ↔ enabled
 *   volume          ↔ volume
 *   rate            ↔ rate
 *   pitch           ↔ pitch
 *   delayMs         ↔ delay_ms (canonicalised to camelCase here)
 *   voice           ↔ preferred_voice
 *   events.scouting — web addition; legacy SPA always spoke the
 *                     scouting card.
 */
type VoicePrefs = {
  enabled: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  delayMs?: number;
  events?: {
    matchStart?: boolean;
    matchEnd?: boolean;
    cheese?: boolean;
    scouting?: boolean;
  };
};

const DEFAULT_PREFS: VoicePrefs = {
  enabled: true,
  rate: 1,
  pitch: 1,
  volume: 1,
  delayMs: 300,
  events: { scouting: true },
};

const EVENT_KEYS = ["scouting", "matchStart", "matchEnd", "cheese"] as const;
const EVENT_LABELS: Record<(typeof EVENT_KEYS)[number], string> = {
  scouting: "Scouting report (pre-game)",
  matchStart: "Match start",
  matchEnd: "Match end",
  cheese: "Cheese detected",
};
const EVENT_DEFAULTS: Record<(typeof EVENT_KEYS)[number], boolean> = {
  scouting: true,
  matchStart: false,
  matchEnd: false,
  cheese: false,
};

export function SettingsVoice() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<VoicePrefs>(
    "/v1/me/preferences/voice",
  );
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const silentTimerRef = useRef<number | null>(null);

  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<VoicePrefs>(
    data,
    DEFAULT_PREFS,
  );

  usePublishDirty("voice", dirty);

  // Populate browser voice list. Chromium loads voices async — we have
  // to listen for ``voiceschanged`` and re-read, otherwise the dropdown
  // is empty on first paint.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => {
      synth.removeEventListener("voiceschanged", load);
      synth.cancel();
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
      if (silentTimerRef.current !== null) {
        window.clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
      return;
    }
    setAutoplayBlocked(false);
    // Mirror the live readout phrasing so the streamer hears exactly
    // what the overlay will say. Keeps Settings → Test honest.
    const utt = new SpeechSynthesisUtterance(buildPreviewPhrase());
    utt.rate = clamp(draft.rate ?? 1, 0.5, 2);
    utt.pitch = clamp(draft.pitch ?? 1, 0, 2);
    utt.volume = clamp(draft.volume ?? 1, 0, 1);
    if (draft.voice) {
      const match = voices.find((v) => v.name === draft.voice);
      if (match) {
        utt.voice = match;
        utt.lang = match.lang || "en-US";
      }
    }
    let started = false;
    utt.onstart = () => {
      started = true;
      if (silentTimerRef.current !== null) {
        window.clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
    };
    utt.onend = () => {
      setPreviewing(false);
      if (silentTimerRef.current !== null) {
        window.clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
    };
    utt.onerror = (ev) => {
      setPreviewing(false);
      if (silentTimerRef.current !== null) {
        window.clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
      const code = (ev as SpeechSynthesisErrorEvent).error;
      if (code === "not-allowed") {
        // Browser blocked the synthesizer for autoplay. The button
        // press IS a user gesture, but some browsers (Safari) gate
        // speech-synthesis specifically on a more-recent gesture
        // and surface this code. Surface a clear unlock UX rather
        // than a confusing toast.
        setAutoplayBlocked(true);
        return;
      }
      if (code && code !== "interrupted" && code !== "canceled") {
        toast.error("Voice preview failed", { description: code });
      }
    };
    utteranceRef.current = utt;
    setPreviewing(true);
    const delay = clamp(draft.delayMs ?? 0, 0, 5000);
    const dispatch = () => {
      window.speechSynthesis.speak(utt);
      // Silent-failure detection: if onstart hasn't fired in 2 s,
      // the engine ate the request without telling us. This matches
      // the overlay's voice-readout.js retry policy so Settings →
      // Test reproduces the same diagnostic UX the streamer would
      // see in OBS.
      silentTimerRef.current = window.setTimeout(() => {
        silentTimerRef.current = null;
        if (started) return;
        setPreviewing(false);
        setAutoplayBlocked(true);
      }, 2000);
    };
    if (delay > 0) window.setTimeout(dispatch, delay);
    else dispatch();
  }

  const groupedVoices = useMemo(() => groupVoices(voices), [voices]);

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <>
      <Section
        title="Voice readout"
        description="Reads the scouting report aloud through the OBS overlay's Web Speech API. Browsers require a one-time click to enable speech — the overlay shows a banner the first time."
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
            <RangeSlider
              label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={draft.volume ?? 1}
              onChange={(volume) => setDraft((d) => ({ ...d, volume }))}
            />
            <RangeSlider
              label="Delay before speaking"
              suffix="ms"
              min={0}
              max={2000}
              step={50}
              value={draft.delayMs ?? 300}
              decimals={0}
              onChange={(delayMs) =>
                setDraft((d) => ({ ...d, delayMs }))
              }
            />
            <div className="flex items-end">
              <PreviewButton previewing={previewing} onClick={preview} />
            </div>
          </div>

          {autoplayBlocked ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-status-warn bg-status-warn-bg px-3 py-2 text-caption text-text"
            >
              <strong>Voice blocked by your browser.</strong>{" "}
              Browsers gate the speech synthesizer behind a recent user
              gesture.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={preview}
              >
                Retry now
              </button>
              {" "}— once this works in Settings, the OBS overlay's
              banner only appears if it loads before your first click.
            </div>
          ) : null}

          <fieldset className="mt-6">
            <legend className="text-caption font-medium uppercase tracking-wider text-text-dim">
              Events to announce
            </legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {EVENT_KEYS.map((k) => (
                <label
                  key={k}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2"
                >
                  <span className="text-caption text-text">{EVENT_LABELS[k]}</span>
                  <Toggle
                    checked={readEvent(draft.events?.[k], EVENT_DEFAULTS[k])}
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
  decimals = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  decimals?: number;
  onChange: (next: number) => void;
}) {
  return (
    <Field
      label={
        <span className="flex items-baseline justify-between gap-2">
          <span>{label}</span>
          <span className="font-mono text-caption text-text-muted">
            {value.toFixed(decimals)}
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

function readEvent(v: boolean | undefined, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function buildPreviewPhrase(): string {
  return (
    "Facing TestUser, Protoss. You're 3 and 1 against them. "
    + "Best answer is 3 Stargate Phoenix, 62 percent win rate."
  );
}
