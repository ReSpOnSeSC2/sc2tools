export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function adjacentReplaySpeed(speed: ReplaySpeed, direction: -1 | 1, wrap = false): ReplaySpeed {
  const index = REPLAY_SPEEDS.indexOf(speed) + direction;
  return REPLAY_SPEEDS[wrap ? (index + REPLAY_SPEEDS.length) % REPLAY_SPEEDS.length : Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, index))];
}

/** Shared verbatim by Help and the in-player sheet. */
export const REPLAY_SHORTCUTS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["J / L", "Back or forward 10 seconds"],
  ["← / →", "Back or forward 1 second (Shift: 5 seconds)"],
  [", / .", "While paused, back or forward one game loop (1/22.4 second)"],
  ["[ / ]", "Slower or faster playback"],
  ["0–9", "Jump to 0–90% of the game"],
  ["Home / End", "Jump to the start or end"],
  ["P / N", "Previous or next notable event"],
  ["F", "Toggle fullscreen"],
  ["M", "Toggle replay music"],
  ["?", "Show keyboard shortcuts"],
];

export function adjacentReplayMarker(markers: readonly { t: number }[], time: number, direction: -1 | 1): number | null {
  let next: number | null = null;
  for (const { t } of markers) {
    if (!Number.isFinite(t) || (direction === 1 ? t <= time + 0.001 : t >= time - 0.001)) continue;
    if (next === null || (direction === 1 ? t < next : t > next)) next = t;
  }
  return next;
}
