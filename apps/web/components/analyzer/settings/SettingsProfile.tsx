"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";

type Profile = {
  battleTag?: string;
  pulseId?: string;
  region?: string;
  preferredRace?: string;
  displayName?: string;
};

export function SettingsProfile() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<Profile>("/v1/me/profile");

  const [draft, setDraft] = useState<Profile>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await apiCall(getToken, "/v1/me/profile", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await mutate();
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <Card title="Profile">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Display name"
          value={draft.displayName || ""}
          onChange={(v) => setDraft((d) => ({ ...d, displayName: v }))}
        />
        <Field
          label="BattleTag"
          value={draft.battleTag || ""}
          onChange={(v) => setDraft((d) => ({ ...d, battleTag: v }))}
        />
        <Field
          label="Pulse ID"
          value={draft.pulseId || ""}
          onChange={(v) => setDraft((d) => ({ ...d, pulseId: v }))}
          help="Auto-detected by the agent on the first sync"
        />
        <Field
          label="Region"
          value={draft.region || ""}
          onChange={(v) => setDraft((d) => ({ ...d, region: v }))}
          help="us, eu, kr, cn"
        />
        <Field
          label="Preferred race"
          value={draft.preferredRace || ""}
          onChange={(v) => setDraft((d) => ({ ...d, preferredRace: v }))}
          help="Terran / Zerg / Protoss / Random"
        />
      </div>
      <div className="mt-4 flex items-center justify-between">
        {savedAt ? (
          <span className="text-xs text-success">Saved.</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="btn"
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <input
        className="input mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && <span className="mt-1 block text-xs text-text-dim">{help}</span>}
    </label>
  );
}
