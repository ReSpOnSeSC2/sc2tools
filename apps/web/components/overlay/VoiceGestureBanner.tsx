"use client";

import type { CSSProperties } from "react";
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
      style={STYLE}
      className="voice-gesture-banner"
    >
      <Volume2 className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span style={LABEL_STYLE}>Click to enable voice readout</span>
    </button>
  );
}

const STYLE: CSSProperties = {
  position: "fixed",
  bottom: 16,
  right: 16,
  zIndex: 99999,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(11,13,18,0.92)",
  color: "#e6e8ee",
  border: "1px solid rgba(62,192,199,0.45)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.55), 0 0 24px rgba(62,192,199,0.18)",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  cursor: "pointer",
  pointerEvents: "auto",
  // Subtle pulse so it draws the eye without dominating the scene.
  animation: "voiceGesturePulse 2.4s ease-in-out infinite",
};

const LABEL_STYLE: CSSProperties = {
  letterSpacing: 0.2,
};
