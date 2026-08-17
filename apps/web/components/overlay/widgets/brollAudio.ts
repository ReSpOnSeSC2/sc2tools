"use client";

import { useEffect, useState } from "react";

const AUDIO_ON = new Set(["1", "true", "on", "yes"]);
const AUDIO_OFF = new Set(["0", "false", "off", "no"]);

/**
 * Choose one audio owner when OBS renders separate horizontal and vertical
 * copies of the reel. Horizontal owns audio by default; vertical is a muted
 * video follower. ``?audio=1`` and ``?audio=0`` override that convention for
 * unusual collections without coupling or reusing either Browser Source.
 */
export function resolveBrollAudioOwner(
  search: string,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const override = new URLSearchParams(search).get("audio");
  if (override !== null) {
    const normalized = override.toLowerCase();
    if (AUDIO_ON.has(normalized)) return true;
    if (AUDIO_OFF.has(normalized)) return false;
    // An explicitly managed source with a damaged role must fail silent. The
    // OBS repair can restore it; guessing from orientation could duplicate a
    // second 1920x1080 player's audio in the meantime.
    return false;
  }

  const width = Number.isFinite(viewportWidth) ? viewportWidth : 0;
  const height = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return width >= height;
}

/**
 * Hydrates muted, then elects from the real OBS viewport. Starting silent is
 * deliberate: it prevents a vertical follower from emitting even a short
 * duplicate burst before client-side orientation is known.
 */
export function useBrollAudioOwner(): boolean {
  const [audioOwner, setAudioOwner] = useState(false);

  useEffect(() => {
    const update = () => {
      setAudioOwner(
        resolveBrollAudioOwner(
          window.location.search,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  return audioOwner;
}
