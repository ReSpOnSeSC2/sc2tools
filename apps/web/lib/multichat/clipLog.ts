import { formatTime } from "@/lib/i18n/format";
import { csvCell } from "@/lib/csvExport";
import { formatOffset } from "@/lib/vodLinks";
import type { ClipMoment } from "./useEngagementState";

export const MOMENT_KIND_LABELS: Record<ClipMoment["kind"], string> = { "chat-spike": "Chat", "game-event": "Game", manual: "Manual" };

export function mergeClipMoments(...pages: ReadonlyArray<ClipMoment>[]): ClipMoment[] {
  const unique = new Map<string, ClipMoment>();
  for (const moment of pages.flat()) unique.set(momentKey(moment), moment);
  return [...unique.values()].sort((a, b) => b.atMs - a.atMs);
}

export const momentKey = (moment: ClipMoment) => JSON.stringify([moment.atMs, moment.kind, moment.reason, moment.gameKey]);

export function clipTimestampText(moments: ReadonlyArray<ClipMoment>, start: number | null): string {
  return [...moments].sort((a, b) => a.atMs - b.atMs).flatMap((moment) => {
    if (start !== null && moment.atMs < start) return [];
    const stamp = start === null ? formatTime(moment.atMs, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : formatOffset(moment.atMs - start);
    return [`${stamp} — ${moment.reason}`];
  }).join("\n");
}

export function clipMomentsCsv(moments: ReadonlyArray<ClipMoment>, start: number | null): string {
  const rows = [["offset", "wall_time_iso", "kind", "reason", "sample_lines"]];
  for (const moment of [...moments].sort((a, b) => a.atMs - b.atMs)) {
    const offset = start !== null && moment.atMs >= start ? formatOffset(moment.atMs - start) : "";
    rows.push([offset, new Date(moment.atMs).toISOString(), moment.kind, moment.reason, moment.sampleLines.join(" | ")]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
