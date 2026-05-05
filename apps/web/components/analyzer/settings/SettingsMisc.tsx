"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { usePublishDirty } from "./SettingsContext";

type Misc = {
  theme?: "dark" | "system";
  defaultTab?: string;
  showWizardOnNextLogin?: boolean;
  analytics?: boolean;
};

const DEFAULT_MISC: Misc = {};

const DEFAULT_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "opponents", label: "Opponents" },
  { value: "strategies", label: "Strategies" },
  { value: "trends", label: "Trends" },
  { value: "battlefield", label: "Battlefield" },
  { value: "builds", label: "Builds" },
  { value: "ml", label: "ML insights" },
  { value: "map-intel", label: "Map intel" },
];

export function SettingsMisc() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<Misc>(
    "/v1/me/preferences/misc",
  );
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<Misc>(
    data,
    DEFAULT_MISC,
  );

  usePublishDirty("misc", dirty);

  async function save() {
    if (saving) return;
    setSaving(true);
    const previous = data;
    try {
      await mutate(draft, { revalidate: false });
      await apiCall(getToken, "/v1/me/preferences/misc", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await mutate();
      markSaved();
      toast.success("Preferences saved");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't save preferences", { description: message });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;

  return (
    <>
      <Section
        title="App preferences"
        description="Default tab, theme behavior, and the small dials that don't fit elsewhere."
      >
        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Theme handling"
              hint="Use 'System' to follow your OS dark/light setting"
            >
              <Select
                value={draft.theme ?? "dark"}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    theme: e.target.value as Misc["theme"],
                  }))
                }
              >
                <option value="dark">Dark (always)</option>
                <option value="system">System</option>
              </Select>
            </Field>
            <Field label="Default tab" hint="Where the analyzer opens by default">
              <Select
                value={draft.defaultTab ?? "opponents"}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, defaultTab: e.target.value }))
                }
              >
                {DEFAULT_TABS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </Section>

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="inline-flex items-center gap-2 text-caption font-medium uppercase tracking-wider text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          <Settings2 className="h-4 w-4" aria-hidden />
          Advanced
        </button>
        {advancedOpen ? (
          <Card>
            <div className="space-y-3">
              <ToggleRow
                title="Show first-run wizard at next login"
                description="Replays the onboarding flow the next time you sign in. Handy for testing or when bringing a new machine online."
                checked={!!draft.showWizardOnNextLogin}
                onChange={(on) =>
                  setDraft((d) => ({ ...d, showWizardOnNextLogin: on }))
                }
              />
              <ToggleRow
                title="Allow anonymous usage telemetry"
                description="Helps us catch regressions. No game data is sent — only client-side errors and feature usage counts."
                checked={!!draft.analytics}
                onChange={(on) => setDraft((d) => ({ ...d, analytics: on }))}
              />
            </div>
          </Card>
        ) : null}
      </section>

      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
    </>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-text">{title}</span>
        <span className="mt-0.5 block text-caption text-text-muted">
          {description}
        </span>
      </span>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </label>
  );
}
