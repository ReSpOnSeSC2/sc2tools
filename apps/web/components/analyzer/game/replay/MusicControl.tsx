"use client";

/**
 * MusicControl — the score's two controls in the transport dock.
 *
 * A toggle and a level, nothing else: the interesting behaviour
 * (selection, fades, the battle swell, the loop rotation) is all in
 * ``lib/replayMusic``, and this component only ever reads state and
 * calls back.
 *
 * Both controls are real, labelled form controls — a ``<button>`` with
 * ``aria-pressed`` and a ``<input type="range">`` — so the score is
 * reachable from the keyboard and announced properly. The toggle click
 * is also load-bearing: it is a user gesture, which is what lets the
 * engine start audio when music is switched on mid-replay.
 */

import { memo } from "react";
import { Music2, VolumeX } from "lucide-react";
import type { ReplayMusicApi } from "@/lib/replayMusic";

const BUTTON_CLASS =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function MusicControlImpl({ music }: { music: ReplayMusicApi }) {
  const { enabled, volume, available, track } = music;

  if (!available) {
    // The asset 404'd or would not decode. Nothing is logged and the
    // replay is untouched; the control just stops offering something
    // it cannot deliver.
    return (
      <button
        type="button"
        disabled
        data-testid="replay-music"
        aria-label="Replay music unavailable"
        title="Replay music unavailable"
        className={`${BUTTON_CLASS} cursor-not-allowed border-border bg-bg-elevated opacity-40`}
      >
        <VolumeX className="h-4 w-4" aria-hidden />
      </button>
    );
  }

  const label = enabled ? "Turn replay music off" : "Turn replay music on";
  const tip = enabled && track ? `${track.title} — ${track.mood}` : label;

  return (
    <div
      data-testid="replay-music"
      role="group"
      aria-label="Replay music"
      className="flex shrink-0 items-center gap-1.5"
    >
      <button
        type="button"
        onClick={() => music.setEnabled(!enabled)}
        aria-label={label}
        aria-pressed={enabled}
        title={tip}
        className={`${BUTTON_CLASS} ${
          enabled
            ? "border-accent bg-accent/15 hover:border-accent"
            : "border-border bg-bg-elevated text-text-muted hover:border-accent"
        }`}
      >
        {enabled ? (
          <Music2 className="h-4 w-4" aria-hidden />
        ) : (
          <VolumeX className="h-4 w-4" aria-hidden />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={(e) => music.setVolume(Number(e.target.value) / 100)}
        aria-label="Replay music volume"
        aria-valuetext={`${Math.round(volume * 100)} percent`}
        title="Music volume"
        className={`h-6 w-16 cursor-pointer accent-[#3ec0c7] ${
          enabled ? "" : "opacity-40"
        }`}
      />
    </div>
  );
}

export const MusicControl = memo(MusicControlImpl);
