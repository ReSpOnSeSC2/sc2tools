"use client";

import { POLL_DURATIONS_SEC, POLL_DURATION_LABELS, isPollDuration, type PollDurationSec } from "@/lib/multichat/poll";
import { DockSelect } from "./DockControls";

export function PollDurationSelect({ value, onChange }: { value: PollDurationSec | null; onChange: (value: PollDurationSec | null) => void }) {
  return <label className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
    Poll duration
    <DockSelect value={value ?? ""} onChange={(event) => {
      const seconds = Number(event.target.value);
      onChange(isPollDuration(seconds) ? seconds : null);
    }}>
      <option value="">No timer</option>
      {POLL_DURATIONS_SEC.map((seconds) => <option key={seconds} value={seconds}>{POLL_DURATION_LABELS[seconds]}</option>)}
    </DockSelect>
  </label>;
}
