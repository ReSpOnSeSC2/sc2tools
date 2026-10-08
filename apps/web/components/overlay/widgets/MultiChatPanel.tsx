"use client";

import type { CSSProperties, ReactNode } from "react";
import { appearanceStyles, type ChatAppearance } from "@/lib/multichat/appearance";

/** Shared chrome and score for the OBS source and the settings preview. */
export function MultiChatPanel({
  appearance,
  score,
  children,
  style,
}: {
  appearance: ChatAppearance;
  score?: { wins: number; losses: number } | null;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const styles = appearanceStyles(appearance);
  const framed = appearance.layout === "framed";
  const decorated = framed && appearance.panelBorder;
  const validScore = score
    && Number.isInteger(score.wins) && score.wins >= 0
    && Number.isInteger(score.losses) && score.losses >= 0;

  return (
    <div
      data-testid="mc-panel"
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: styles.panelBackground,
        border: appearance.panelBorder
          ? framed ? "4px ridge #777d80" : "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))"
          : "none",
        borderRadius: appearance.cornerRadius,
        boxShadow: appearance.bgOpacity > 5
          ? decorated
            ? "inset 0 0 0 1px #4b2025, 0 6px 20px rgba(0,0,0,0.45)"
            : "0 6px 20px rgba(0,0,0,0.45)"
          : "none",
        overflow: "hidden",
        ...style,
      }}
    >
      {decorated ? ["tl", "tr", "bl", "br"].map((corner) => (
        <span
          key={corner}
          aria-hidden
          style={{
            position: "absolute", zIndex: 1, pointerEvents: "none",
            width: 13, height: 13,
            top: corner.startsWith("t") ? 0 : undefined,
            bottom: corner.startsWith("b") ? 0 : undefined,
            left: corner.endsWith("l") ? 0 : undefined,
            right: corner.endsWith("r") ? 0 : undefined,
            borderTop: corner.startsWith("t") ? "3px solid #afb3b5" : undefined,
            borderBottom: corner.startsWith("b") ? "3px solid #afb3b5" : undefined,
            borderLeft: corner.endsWith("l") ? "3px solid #afb3b5" : undefined,
            borderRight: corner.endsWith("r") ? "3px solid #afb3b5" : undefined,
          }}
        />
      )) : null}
      {appearance.showSessionScore ? (
        <div
          data-testid="mc-session-score"
          aria-label={validScore
            ? `Session record: ${score.wins} wins, ${score.losses} losses`
            : "Session record unavailable"}
          style={{
            flexShrink: 0,
            padding: "16px 12px 14px",
            borderBottom: framed ? "1px solid #314328" : "1px solid rgba(255,255,255,0.12)",
            fontFamily: styles.fontFamily,
            color: "#ffffff",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: Math.min(64, Math.max(32, Math.round(appearance.fontSize * 1.6))), fontWeight: 700, lineHeight: 1.15, fontVariantNumeric: "tabular-nums" }}>
            {validScore ? `${score.wins} : ${score.losses}` : "— : —"}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#a5ada8" }}>
            SESSION · W:L
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}
