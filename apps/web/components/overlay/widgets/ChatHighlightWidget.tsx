"use client";

/**
 * ChatHighlightWidget — the pinned chat message, on stream.
 *
 * The streamer pins a message from the Stream Dock; the studio state
 * (fetched + pushed as ``overlay:multichat``) carries it here. Fully
 * studio-driven: when no highlight is pinned the source is perfectly
 * transparent, and every pin swap re-plays the entry fade so the card
 * pops even when only the text changed.
 */

import { useMemo, type CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { PLATFORM_META } from "./MultiChatMessageList";

export function ChatHighlightWidget({
  token,
  studioEvent,
}: {
  token: string;
  /** Latest raw ``overlay:multichat`` socket payload from the host. */
  studioEvent?: unknown;
}) {
  const state = useStudioState(token, studioEvent ?? null);
  const highlight = state.highlight;

  // Key the card on the pin identity so replacing one highlight with
  // another remounts it and replays the fade-in.
  const cardKey = useMemo(
    () =>
      highlight ? `${highlight.platform}:${highlight.user}:${highlight.atMs}` : "",
    [highlight],
  );

  if (!highlight) return <div style={{ background: "transparent" }} />;

  const meta = PLATFORM_META[highlight.platform];

  return (
    <div style={frameStyle}>
      <style>{`
        .chat-highlight-card { animation: chFadeIn 320ms ease-out; }
        @keyframes chFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-highlight-card { animation: none; }
        }
      `}</style>
      <div key={cardKey} className="chat-highlight-card" style={cardStyle}>
        <div style={headerRowStyle}>
          <span style={titleStyle}>CHAT HIGHLIGHT</span>
          <span
            style={{
              ...chipStyle,
              background: meta.color,
              color: meta.fg,
            }}
            title={meta.label}
            aria-label={meta.label}
          >
            {meta.short}
          </span>
        </div>
        <div style={quoteStyle}>
          <span aria-hidden style={quoteMarkStyle}>&ldquo;</span>
          {highlight.text}
          <span aria-hidden style={quoteMarkStyle}>&rdquo;</span>
        </div>
        <div style={authorRowStyle}>
          <span style={{ opacity: 0.55 }}>&mdash;</span>
          <span style={{ fontWeight: 700, color: "#fff" }}>
            {highlight.user}
          </span>
          <span style={{ opacity: 0.5 }}>on {meta.label}</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "flex-start",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 260,
  maxWidth: 640,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  padding: "14px 18px",
  color: "#e6e8ee",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  overflow: "hidden",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.14em",
  color: "var(--ov-accent, #3ec0c7)",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 26,
  height: 16,
  padding: "0 5px",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.04em",
  flexShrink: 0,
};

const quoteStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.4,
  color: "rgba(255,255,255,0.95)",
  overflowWrap: "anywhere",
  textShadow: "0 1px 2px rgba(0,0,0,0.5)",
};

const quoteMarkStyle: CSSProperties = {
  color: "var(--ov-accent, #3ec0c7)",
  fontWeight: 800,
  margin: "0 2px",
};

const authorRowStyle: CSSProperties = {
  marginTop: 10,
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  fontSize: 14,
};
