import type { MapPlayback } from "./mapReplay";

export type ReplayCameraMode = "free" | "me" | "opp";
export type CameraPoint = { x: number; y: number };

/** Drop a malformed camera track while preserving the other replay data. */
export function sanitizeReplayCamera(raw: unknown, gameLength: number): MapPlayback["camera"] {
  if (!raw || typeof raw !== "object") return undefined;
  const tracks: NonNullable<MapPlayback["camera"]> = {};
  for (const side of ["me", "opp"] as const) {
    const row = (raw as Record<string, unknown>)[side];
    if (!Array.isArray(row) || !row.length || row.length % 3 || row.length > 43200) continue;
    let last = -1;
    let valid = true;
    for (let index = 0; index < row.length; index += 3) {
      const [time, x, y] = row.slice(index, index + 3);
      if (![time, x, y].every(Number.isFinite) || time <= last || time < 0 || time > gameLength || Math.abs(x) > 4096 || Math.abs(y) > 4096) {
        valid = false;
        break;
      }
      last = time;
    }
    if (valid) tracks[side] = row;
  }
  return tracks.me || tracks.opp ? tracks : undefined;
}

/** Last recorded position at this moment. No pose is known before the first sample. */
export function replayCameraAt(track: readonly number[] | undefined, time: number): CameraPoint | null {
  if (!track?.length || !Number.isFinite(time) || time < track[0]) return null;
  let start = 0;
  let end = track.length / 3;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (track[middle * 3] <= time) start = middle + 1;
    else end = middle;
  }
  const index = (start - 1) * 3;
  return { x: track[index + 1], y: track[index + 2] };
}
