"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import {
  DENSITIES, HOUR_CYCLES, LOCALE_CHOICES, MOTION_CHOICES, TEXT_SIZES, WEEK_STARTS,
  DEFAULT_APPEARANCE, sanitizeAppearance, setStoredAppearance,
  type AppearancePrefs,
} from "@/lib/appearance";
import { createFormatter, dayName, formatPrefsOf } from "@/lib/i18n/format";
import { Card, Skeleton } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useSaveSource } from "./SettingsContext";

const PATH = "/v1/me/preferences/appearance";
/** Sample moment for the preview: a weekday afternoon. */
const SAMPLE = new Date(2026, 10, 10, 14, 30);

/**
 * Settings → Preferences → Appearance & region. Saved to the account with
 * the rest of Preferences through the tab's one SaveBar; after the save
 * this browser keeps a copy so text size and density apply before the
 * first paint on the next load.
 */
export function SettingsAppearance() {
  const { userId } = useAuth();
  return userId ? <AppearanceForm key={userId} /> : null;
}

function AppearanceForm() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data, error, isLoading, mutate } = useApi<unknown>(PATH, { revalidateOnFocus: false });
  const server = useMemo(() => (data === undefined ? undefined : sanitizeAppearance(data)), [data]);
  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm<AppearancePrefs>(server, { ...DEFAULT_APPEARANCE });
  const [saving, setSaving] = useState(false);
  const [browserLocale, setBrowserLocale] = useState<string | null>(null);
  useEffect(() => { setBrowserLocale(new Intl.DateTimeFormat().resolvedOptions().locale); }, []);
  useSaveSource("preferences", { label: "appearance", dirty, save, reset, order: 1 }, "appearance");

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    if (saving) return false;
    setSaving(true);
    try {
      const saved = sanitizeAppearance(await apiCall<unknown>(getToken, PATH, { method: "PUT", body: JSON.stringify(draft) }));
      await mutate(saved, { revalidate: false });
      markSaved();
      // This browser follows right away: text size, density and formats.
      setStoredAppearance(saved);
      toast.success("Appearance saved");
      return true;
    } catch (cause) {
      toast.error("Couldn't save appearance", { description: (cause as ClientApiError | undefined)?.message ?? "Please try again." });
      return false;
    } finally {
      setSaving(false);
    }
  }

  const preview = useMemo(() => createFormatter(formatPrefsOf(draft)), [draft]);
  const set = <K extends keyof AppearancePrefs>(key: K, value: AppearancePrefs[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const scale = Number(draft.textSize) / 100;
  // 1 November 2026 is a Sunday, so day 1 + n is weekday n.
  const weekdayName = preview.date(new Date(2026, 10, 1 + preview.weekStartDay), { weekday: "long" });

  return (
    <Section
      id="appearance"
      className="scroll-mt-28"
      title="Appearance & region"
      description="Motion, text size, spacing, and how dates, times and numbers look. Saved to your account, so every browser you sign in to follows them. OBS overlays keep their own layout."
    >
      {isLoading && data === undefined ? <Skeleton rows={3} /> : error && data === undefined ? (
        <RequestError error={error} onRetry={() => void mutate()} />
      ) : (
        <Card>
          <fieldset disabled={saving} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <legend className="sr-only">Appearance and region preferences</legend>
            <Field label="Motion" hint="System follows the reduced motion setting on your device.">
              <Select value={draft.motion} onChange={(event) => set("motion", event.target.value as AppearancePrefs["motion"])}>
                {MOTION_CHOICES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Text size" hint="Enlarges text across the site without zooming the page.">
              <Select value={draft.textSize} onChange={(event) => set("textSize", event.target.value as AppearancePrefs["textSize"])}>
                {TEXT_SIZES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Density" hint="Compact tightens table rows and card padding to show more at once.">
              <Select value={draft.density} onChange={(event) => set("density", event.target.value as AppearancePrefs["density"])}>
                {DENSITIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Language and region for dates and numbers" hint="The site's wording stays in English.">
              <Select value={draft.locale} onChange={(event) => set("locale", event.target.value)}>
                <option value="auto">{browserLocale ? `Automatic (this browser: ${browserLocale})` : "Automatic (this browser)"}</option>
                {LOCALE_CHOICES.some((item) => item.value === draft.locale) || draft.locale === "auto" ? null : <option value={draft.locale}>{draft.locale}</option>}
                {LOCALE_CHOICES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Clock">
              <Select value={draft.hourCycle} onChange={(event) => set("hourCycle", event.target.value as AppearancePrefs["hourCycle"])}>
                {HOUR_CYCLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Week starts on" hint="Used by Last week, weekly charts and the activity calendar.">
              <Select value={draft.weekStart} onChange={(event) => set("weekStart", event.target.value as AppearancePrefs["weekStart"])}>
                {WEEK_STARTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
          </fieldset>
          <div role="group" aria-label="Preview" className="mt-4 rounded-lg border border-border bg-bg-elevated/40 p-3">
            <p className="text-caption font-semibold text-text-muted">Preview</p>
            <p className="mt-1 text-text" style={{ fontSize: `${15 * scale}px`, lineHeight: `${24 * scale}px` }}>
              {preview.date(SAMPLE, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              {" · "}{preview.time(SAMPLE, { hour: "numeric", minute: "2-digit" })}
              {" · "}{preview.number(12345.6)} games
            </p>
            <p className="mt-1 text-caption text-text-muted" data-week-start={dayName(preview.weekStartDay)}>
              Weeks start on {weekdayName}.{draft.density === "compact" ? " Compact spacing." : ""}
            </p>
          </div>
        </Card>
      )}
    </Section>
  );
}
