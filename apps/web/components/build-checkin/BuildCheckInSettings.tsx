"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { SaveBar } from "@/components/ui/SaveBar";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { useToastOptional } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useApi } from "@/lib/clientApi";
import { usePublishDirty } from "@/components/analyzer/settings/SettingsContext";
import {
  BUILD_CHECKIN_PREFS_PATH,
  DEFAULT_CHECKIN_PREFS,
  buildIntentErrorMessage,
  putCheckinPrefs,
  sanitizeCheckinPrefs,
  type BuildCheckinPrefs,
} from "@/lib/buildIntent";
import {
  useBuildCheckInPrefsRevision,
  useBuildCheckInRevision,
} from "./BuildCheckInProvider";

/**
 * Settings · Build check-in — the three cloud switches shared with the
 * desktop agent (`/v1/me/preferences/buildCheckin`). Drafts follow the
 * rest of Settings: nothing is written until Save. A change made in the
 * desktop app shows up here live unless there are unsaved edits.
 */
export function BuildCheckInSettings() {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const { bump } = useBuildCheckInRevision(false);
  const { data, error, isLoading, mutate } = useApi<unknown>(BUILD_CHECKIN_PREFS_PATH);
  const prefsRevision = useBuildCheckInPrefsRevision();
  useEffect(() => {
    if (prefsRevision > 0) void mutate();
  }, [prefsRevision, mutate]);
  const serverPrefs = useMemo<BuildCheckinPrefs | undefined>(
    () => (data === undefined ? undefined : sanitizeCheckinPrefs(data)),
    [data],
  );
  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<BuildCheckinPrefs>(
    serverPrefs,
    DEFAULT_CHECKIN_PREFS,
  );
  const [saving, setSaving] = useState(false);
  usePublishDirty("checkin", dirty);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await putCheckinPrefs(getToken, draft);
      await mutate(saved, { revalidate: false });
      markSaved();
      // The header chip hides or reappears with the master switch.
      bump();
      toastContext?.toast.success("Build check-in settings saved");
    } catch (err) {
      toastContext?.toast.error("Couldn't save build check-in settings", {
        description: buildIntentErrorMessage(err),
      });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading && data === undefined) return <Skeleton rows={3} />;

  if (error && data === undefined) {
    return (
      <Section id="build-check-in" className="scroll-mt-28" title="Build check-in">
        <Card role="alert">
          <p className="text-caption text-text-muted">
            Couldn't load your build check-in settings. {buildIntentErrorMessage(error)}
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void mutate()}>
            Try again
          </Button>
        </Card>
      </Section>
    );
  }

  const set = (patch: Partial<BuildCheckinPrefs>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <>
      <Section
        id="build-check-in" className="scroll-mt-28"
        title="Build check-in"
        description="Game-screen prompts are off by default. Choose which ones you want. A confirmed check-in counts the game toward your planned build's record, even when the replay was classified as something else."
      >
        <Card>
          <div className="space-y-3">
            <ToggleRow
              title="Build check-ins"
              description="Queue fresh games for a check-in and show the header chip. When off, nothing is queued and the desktop agent stays quiet. You can still set a planned build from any game page."
              checked={draft.enabled}
              onChange={(enabled) => set({ enabled })}
            />
            <ToggleRow
              title="Ask during the loading screen"
              description="The desktop agent shows a small “What's the plan?” card while the game loads. It never takes focus from StarCraft II and is hidden from stream capture."
              checked={draft.askAtLoading}
              disabled={!draft.enabled}
              onChange={(askAtLoading) => set({ askAtLoading })}
            />
            <ToggleRow
              title="Ask after each game"
              description="The desktop agent asks which build you were going for when the game ends, with its best guess from your replay already selected."
              checked={draft.askAfterGame}
              disabled={!draft.enabled}
              onChange={(askAfterGame) => set({ askAfterGame })}
            />
          </div>
        </Card>
        <Card>
          <h3 className="text-caption font-semibold text-text">What counts</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-text-muted">
            <li>
              Only confirmed check-ins change your stats. Suggestions and randomizer
              rolls never do on their own.
            </li>
            <li>
              Your own records (Builds, your build library, MMR, trends and overlay
              widgets) use the planned build. Community guides, ladder meta and
              coaching keep the replay's own label.
            </li>
            <li>Games under 45 seconds never count toward a build.</li>
          </ul>
          <LazyHelpLink
            slug="build-check-in"
            className="mt-3 inline-flex min-h-11 items-center text-caption font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            How build check-in works, step by step
          </LazyHelpLink>
        </Card>
      </Section>

      <SaveBar visible={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={[
        "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-text">{title}</span>
        <span className="mt-0.5 block text-caption text-text-muted">{description}</span>
      </span>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} label={title} />
    </label>
  );
}
