"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { NotificationPreferences } from "@/components/notifications/NotificationPreferences";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { SettingsLoadError } from "./SettingsLoadError";
import {
  isAnalyticsConfigured,
  readConsent,
  setConsent,
  withdrawConsent,
  subscribeConsent,
  type ConsentState,
} from "@/lib/analytics/consent";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { TODAY_DEFAULT_TAB } from "@/components/analyzer/tabs";
import { usePublishDirty } from "./SettingsContext";

type Misc = {
  defaultTab?: string;
};

const DEFAULT_MISC: Misc = {};

/**
 * Keys older versions of this page saved that nothing reads any more
 * (a first-run wizard switch and a telemetry switch). The PUT replaces
 * the whole preference doc, so leaving them out of the next save
 * removes them.
 */
const RETIRED_MISC_KEYS: readonly string[] = ["showWizardOnNextLogin", "analytics"];

/**
 * The doc to save: the draft without retired keys.
 *
 * Example:
 *   miscForSave({ defaultTab: "trends", analytics: true }); // -> { defaultTab: "trends" }
 */
export function miscForSave(draft: Misc): Misc {
  return Object.fromEntries(
    Object.entries(draft).filter(([key]) => !RETIRED_MISC_KEYS.includes(key)),
  ) as Misc;
}

// Today first (the default), then components/analyzer/tabs.ts TABS —
// the values must be real TabIds or the Today route ignores the
// preference (the old "ml" entry pointed at a tab that no longer exists).
const DEFAULT_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: TODAY_DEFAULT_TAB, label: "Today (default)" },
  { value: "replays", label: "Replays" },
  { value: "opponents", label: "Opponents" },
  { value: "strategies", label: "Strategies" },
  { value: "trends", label: "Trends" },
  { value: "macro", label: "Macro" },
  { value: "battlefield", label: "Maps" },
  { value: "builds", label: "Builds" },
  { value: "arcade", label: "Arcade" },
];

export function SettingsMisc() {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<Misc>(
    "/v1/me/preferences/misc",
  );
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<Misc>(
    data,
    DEFAULT_MISC,
  );

  usePublishDirty("misc", dirty);

  async function save() {
    if (saving) return;
    setSaving(true);
    const previous = data;
    const body = miscForSave(draft);
    try {
      await mutate(body, { revalidate: false });
      await apiCall(getToken, "/v1/me/preferences/misc", {
        method: "PUT",
        body: JSON.stringify(body),
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
  if (error && data === undefined) return <SettingsLoadError tab="Misc settings" error={error} retry={mutate} />;

  return (
    <>
      <Section
        title="App preferences"
        description="Where SC2 Tools opens, and the small dials that don't fit elsewhere."
      >
        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Default tab"
              hint="Where the dashboard opens the first time you visit it in a browser session. Clicking Today always shows Today."
            >
              <Select
                value={draft.defaultTab ?? TODAY_DEFAULT_TAB}
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

      <Section title="Setup & privacy">
        <Card>
          <div className="divide-y divide-border">
            <SettingRow
              title="Setup guide"
              description="Go through the first-run steps again: download the desktop app, pair it and import your replays. Your games and settings stay as they are."
              action={
                <Link
                  href="/welcome"
                  className={[
                    "hard-press inline-flex min-h-11 flex-shrink-0 items-center justify-center gap-2 rounded-full border-2 border-line bg-bg-surface px-4 font-display text-caption font-bold text-text hover:bg-bg-elevated",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  ].join(" ")}
                >
                  Run setup again
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              }
            />
            <AnalyticsCookiesRow />
          </div>
        </Card>
      </Section>

      <NotificationPreferences />
      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
    </>
  );
}

const CONSENT_STATUS: Record<ConsentState, { label: string; variant: BadgeVariant }> = {
  granted: { label: "On", variant: "success" },
  denied: { label: "Off", variant: "neutral" },
  unset: { label: "Not chosen yet", variant: "warning" },
};

/**
 * The real analytics consent for this browser (the cookie banner's
 * store), changed right away rather than through Save. Follows changes
 * made in the banner or another tab.
 */
function AnalyticsCookiesRow() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => "unset" as const,
  );
  const turnOnRef = useRef<HTMLButtonElement>(null);
  const configured = isAnalyticsConfigured();
  const status = configured
    ? CONSENT_STATUS[consent]
    : { label: "Not used", variant: "neutral" as const };

  const keepOff = () => {
    withdrawConsent();
    // "Keep off" goes away with the choice; keep focus in the row.
    turnOnRef.current?.focus();
  };

  return (
    <SettingRow
      title="Analytics cookies"
      status={status}
      description={
        <>
          {configured
            ? "Google Analytics shows us which pages get used, so we know what to improve. No ads, no data selling."
            : "This site doesn't use analytics cookies."}{" "}
          <Link
            href="/legal/privacy"
            className="rounded-sm font-medium text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Privacy Policy
          </Link>
          <span className="mt-1 block text-micro text-text-dim">
            Applies to this browser
          </span>
        </>
      }
      action={
        configured ? (
          <div className="flex flex-wrap gap-2">
            {consent === "granted" ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label="Turn off analytics cookies"
                onClick={withdrawConsent}
              >
                Turn off
              </Button>
            ) : (
              <Button
                ref={turnOnRef}
                variant="secondary"
                size="sm"
                aria-label="Turn on analytics cookies"
                onClick={() => setConsent("granted")}
              >
                Turn on
              </Button>
            )}
            {consent === "unset" ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Keep analytics cookies off"
                onClick={keepOff}
              >
                Keep off
              </Button>
            ) : null}
          </div>
        ) : null
      }
    />
  );
}

function SettingRow({
  title,
  status,
  description,
  action,
}: {
  title: string;
  /** Current state, announced when it changes. */
  status?: { label: string; variant: BadgeVariant };
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-body font-medium text-text">{title}</h3>
          {status ? (
            <span role="status">
              <span className="sr-only">{title}: </span>
              <Badge variant={status.variant} size="sm">
                {status.label}
              </Badge>
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-caption text-text-muted">{description}</div>
      </div>
      {action}
    </div>
  );
}
