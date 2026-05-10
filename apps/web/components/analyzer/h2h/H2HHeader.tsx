"use client";

import type { Bucket } from "@/lib/h2hSeries";
import type { PresetId } from "@/lib/datePresets";
import { PresetPill, type PresetLabels } from "./shared/presetLabel";

type Props = {
  presetLabels: PresetLabels;
  bucket: Bucket;
  setBucket: (b: Bucket) => void;
  bucketDisabled: { day: boolean; week: boolean; month: boolean };
  rollingWindow: number;
  setRollingWindow: (n: number) => void;
  rollingOptions: number[];
  showBucketAndRolling: boolean;
};

/**
 * Header strip with the active-preset pill + the timeline-specific
 * controls (bucket + rolling window). The map split and matrix size
 * controls live inside their own views since they're view-specific.
 */
export function H2HHeader({
  presetLabels,
  bucket,
  setBucket,
  bucketDisabled,
  rollingWindow,
  setRollingWindow,
  rollingOptions,
  showBucketAndRolling,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-caption font-semibold text-text">
        H2H trends
      </h3>
      <PresetPill labels={presetLabels} />
      {showBucketAndRolling ? (
        <>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-caption text-text-muted">
              <span className="text-[10px] uppercase tracking-wider text-text-dim">
                Rolling
              </span>
              <select
                value={String(rollingWindow)}
                onChange={(e) => setRollingWindow(Number(e.target.value))}
                className="min-h-[44px] rounded-md border border-border bg-bg-elevated px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {rollingOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} games
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-caption text-text-muted">
              <span className="text-[10px] uppercase tracking-wider text-text-dim">
                Bucket
              </span>
              <select
                value={bucket}
                onChange={(e) => setBucket(e.target.value as Bucket)}
                className="min-h-[44px] rounded-md border border-border bg-bg-elevated px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="day" disabled={bucketDisabled.day}>
                  Day
                </option>
                <option value="week" disabled={bucketDisabled.week}>
                  Week
                </option>
                <option value="month" disabled={bucketDisabled.month}>
                  Month
                </option>
              </select>
            </label>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function inferBucketDefault(
  preset: PresetId,
  totalDays: number,
  storedBucket: Bucket | null,
): Bucket {
  if (preset === "today" || preset === "yesterday") return "day";
  if (preset === "last_7d" || preset === "last_week") return "week";
  if (preset === "all" && totalDays > 730 && storedBucket == null) {
    return "month";
  }
  return storedBucket || "week";
}

export function bucketDisabledFor(preset: PresetId): {
  day: boolean;
  week: boolean;
  month: boolean;
} {
  if (preset === "today" || preset === "yesterday") {
    return { day: false, week: true, month: true };
  }
  if (preset === "last_7d" || preset === "last_week") {
    return { day: false, week: false, month: true };
  }
  return { day: false, week: false, month: false };
}
