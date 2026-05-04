"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";

type VoicePrefs = {
  enabled: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  events?: { matchStart?: boolean; matchEnd?: boolean; cheese?: boolean };
};

export function SettingsVoice() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<VoicePrefs>(
    "/v1/me/preferences/voice",
  );

  const [draft, setDraft] = useState<VoicePrefs>({
    enabled: false,
    rate: 1,
    pitch: 1,
    events: {},
  });
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function save() {
    await apiCall(getToken, "/v1/me/preferences/voice", {
      method: "PUT",
      body: JSON.stringify(draft),
    });
    await mutate();
  }

  if (isLoading) return <Skeleton rows={3} />;

  return (
    <Card title="Voice readout">
      <p className="mb-3 text-xs text-text-muted">
        Reads opponent name, race, and matchup record aloud through the OBS
        overlay&rsquo;s Web Speech API. Useful for streamers with low-vision
        viewers.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!draft.enabled}
          onChange={(e) =>
            setDraft((d) => ({ ...d, enabled: e.target.checked }))
          }
        />
        Enable voice readout
      </label>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Range
          label={`Rate (${(draft.rate ?? 1).toFixed(1)}x)`}
          value={draft.rate ?? 1}
          min={0.5}
          max={2}
          step={0.1}
          onChange={(v) => setDraft((d) => ({ ...d, rate: v }))}
        />
        <Range
          label={`Pitch (${(draft.pitch ?? 1).toFixed(1)})`}
          value={draft.pitch ?? 1}
          min={0.5}
          max={2}
          step={0.1}
          onChange={(v) => setDraft((d) => ({ ...d, pitch: v }))}
        />
      </div>

      <fieldset className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="text-xs uppercase text-text-dim">Events</legend>
        {(["matchStart", "matchEnd", "cheese"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!draft.events?.[k]}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  events: { ...d.events, [k]: e.target.checked },
                }))
              }
            />
            {k}
          </label>
        ))}
      </fieldset>

      <div className="mt-4 flex justify-end">
        <button type="button" className="btn" onClick={save}>
          Save voice prefs
        </button>
      </div>
    </Card>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <input
        type="range"
        className="mt-1 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
