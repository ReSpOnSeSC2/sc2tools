import { SHARE_TOKEN_RE, shareApiPath } from "@/lib/gameShares";
import { sanitizeMapPlayback, type MapPlayback } from "@/lib/mapReplay";
import { decodePlaybackSegment, readBoundedSegment, sanitizePlaybackManifest, segmentAt } from "@/lib/segmentedPlayback";
import type { SharedGameAnalysis } from "@/lib/sharedGame";

/** Read the exact scoped recording windows needed for an image. */
export async function loadSharedReplayFrames(base: string, token: string, mode: SharedGameAnalysis["playback"]["mode"], times: readonly number[]) {
  const frames = new Map<number, MapPlayback>();
  const requested = [...new Set(times.filter((time) => Number.isFinite(time) && time >= 0))].slice(0, 2);
  if (!requested.length || mode === "none" || !SHARE_TOKEN_RE.test(token)) return frames;
  const path = `${base}${shareApiPath(token)}/map-playback`;
  try {
    const options = { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000) } as const;
    if (mode === "inline") {
      const response = await fetch(path, options);
      const playback = response.ok ? sanitizeMapPlayback(await response.json()) : null;
      if (playback) for (const time of requested) frames.set(time, playback);
    } else {
      const response = await fetch(`${path}/manifest`, options);
      const manifest = response.ok ? sanitizePlaybackManifest(await response.json()) : null;
      if (!manifest) return frames;
      const windows = new Map<number, MapPlayback>();
      for (const time of requested) {
        if (time > manifest.gameLength) continue;
        const entry = segmentAt(manifest, time);
        let playback = windows.get(entry.index);
        if (!playback) {
          const segment = await fetch(`${path}/artifacts/${manifest.artifactId}/segments/${entry.index}`, options);
          const bytes = await readBoundedSegment(segment, entry.sizeBytes);
          playback = await decodePlaybackSegment(bytes, manifest, entry);
          windows.set(entry.index, playback);
        }
        frames.set(time, playback);
      }
    }
  } catch {
    // Missing, revoked, timed-out and invalid recordings use army samples.
  }
  return frames;
}
