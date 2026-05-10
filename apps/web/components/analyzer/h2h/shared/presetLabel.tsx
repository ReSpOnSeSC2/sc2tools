"use client";

import { useFilters } from "@/lib/filterContext";
import {
  longLabelFor,
  shortLabelFor,
  toDateInputValue,
  type PresetId,
} from "@/lib/datePresets";

/**
 * Helpers for surfacing the active global date preset inside the H2H
 * section. Used as a sub-line on every headline metric so a user
 * inspecting "Current streak: W3 · in 30d" can confirm at a glance
 * which window the count is over.
 *
 * `useActivePresetLabels` returns both forms (short + long) and the
 * resolved date range string for the "custom" preset.
 */

export type PresetLabels = {
  presetId: PresetId;
  short: string;
  long: string;
  /** Set when preset === "custom" — the range as `Mar 4 – May 10`. */
  customRange: string | null;
};

export function useActivePresetLabels(): PresetLabels {
  const { filters, seasons } = useFilters();
  const presetId: PresetId = filters.preset || "all";
  const short = shortLabelFor(presetId, seasons);
  const long = longLabelFor(presetId, seasons);
  const customRange =
    presetId === "custom" ? formatCustomRange(filters.since, filters.until) : null;
  return { presetId, short, long, customRange };
}

function formatCustomRange(
  since: string | undefined,
  until: string | undefined,
): string {
  const a = since ? compactDate(since) : "—";
  const b = until ? compactDate(until) : "—";
  return `${a} – ${b}`;
}

function compactDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return toDateInputValue(undefined);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Inline pill rendering the active preset's short label. Matches the
 * "Win rate · Season 67" treatment used elsewhere in the analyzer.
 */
export function PresetPill({ labels }: { labels: PresetLabels }) {
  const display = labels.customRange || labels.short;
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-muted"
      title={labels.customRange ? `Custom range: ${display}` : labels.long}
    >
      {display}
    </span>
  );
}
