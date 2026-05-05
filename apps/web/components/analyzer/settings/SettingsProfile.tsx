"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { usePublishDirty } from "./SettingsContext";

type Profile = {
  battleTag?: string;
  pulseId?: string;
  region?: string;
  preferredRace?: string;
  displayName?: string;
};

const DEFAULT_PROFILE: Profile = {};

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

export function SettingsProfile() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<Profile>("/v1/me/profile");
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<Profile>(
    data,
    DEFAULT_PROFILE,
  );

  usePublishDirty("profile", dirty);

  async function save() {
    if (saving) return;
    setSaving(true);
    // Optimistic: assume success for the local SWR cache, roll back on error.
    const previous = data;
    try {
      await mutate(draft, { revalidate: false });
      await apiCall(getToken, "/v1/me/profile", {
        method: "PUT",
        body: JSON.stringify(draft),
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

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <>
      <Section
        title="Profile"
        description="How you appear in your dashboard and overlay cards. BattleTag and Pulse ID let us link cloud games to your in-game identity."
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
            <Field
              label="Pulse ID"
              hint="Auto-detected by the agent on the first sync"
            >
              <Input
                value={draft.pulseId ?? ""}
                placeholder="Auto-detected"
                inputMode="numeric"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, pulseId: e.target.value }))
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

      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
    </>
  );
}
