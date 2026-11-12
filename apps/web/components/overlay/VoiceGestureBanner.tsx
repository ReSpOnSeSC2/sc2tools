"use client";

import { Volume2 } from "lucide-react";

/**
 * One-time prompt the streamer dismisses to unlock browser speech.
 *
 * Browsers (and OBS Browser Source) refuse to play synthesised speech
 * until they've seen a user gesture on the page. This banner — pinned
 * bottom-right of the overlay frame — gives the streamer something to
 * click. After the click the parent flips ``needsGesture`` to false
 * and the banner unmounts; subsequent voice events fire silently.
 *
 * Click bubbles up to the document so the parent's gesture handler
 * fires too — the banner doesn't have to know the unlock callback.
 */
export function VoiceGestureBanner({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="voice-gesture-banner"
    >
      <Volume2 className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span>Click to enable voice readout</span>
    </button>
  );
}
