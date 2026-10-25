"use client";
import { withOverlayDemo } from "../OverlayDemoBoundary";

import { useEffect, useId, useRef, type CSSProperties } from "react";
import {
  BUILD_PROFILE_AXES,
  isBuildProfileComplete,
  useStudioState,
  type StudioBuildProfile,
} from "@/lib/multichat/useStudioState";
function wrapLabel(label: string): string[] {
  const words = label.trim().split(/\s+/).flatMap((word) => word.match(/.{1,16}/gu) ?? []);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= 16) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** A manual build assessment. No replay metrics or player identifiers enter it. */
export function BuildProfileChart({ profile, preview = false }: {
  profile: StudioBuildProfile;
  preview?: boolean;
}) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const cx = 320, cy = 274, radius = 125;
  useEffect(() => {
    // Constrain unusually wide words within their reserved label column.
    for (const span of svgRef.current?.querySelectorAll<SVGTSpanElement>(".profile-label-line") ?? []) {
      span.removeAttribute("textLength");
      span.removeAttribute("lengthAdjust");
      if (typeof span.getComputedTextLength === "function" && span.getComputedTextLength() > 170) {
        span.setAttribute("textLength", "170");
        span.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
  }, [profile.labels]);
  const point = (index: number, scale: number) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / 5;
    return { x: cx + Math.cos(angle) * radius * scale, y: cy + Math.sin(angle) * radius * scale };
  };
  const polygon = (scale: number) => BUILD_PROFILE_AXES.map((_, index) => {
    const p = point(index, scale);
    return `${p.x},${p.y}`;
  }).join(" ");
  const complete = isBuildProfileComplete(profile);
  const anchors = [
    { x: 320, y: 32 },
    { x: 535, y: 177 },
    { x: 447, y: 448 },
    { x: 193, y: 448 },
    { x: 105, y: 177 },
  ];

  return (
    <section className="build-profile-card" aria-label={`Build profile: ${profile.title || "Untitled build"}`} style={cardStyle}>
      <style>{`
        .build-profile-card { box-sizing: border-box; }
      `}</style>
      <div style={{ fontSize: 20, letterSpacing: "0.12em", fontWeight: 600, color: "var(--ov-accent, #53d6d1)" }}>
        {preview ? "PREVIEW · BUILD PROFILE" : "BUILD PROFILE"}
      </div>
      <h2 style={{ margin: "8px 0 0", fontSize: profile.title.length > 50 ? 30 : 36, lineHeight: 1.15, fontWeight: 600, overflowWrap: "anywhere" }}>
        {profile.title || "Name your build"}
      </h2>
      <svg ref={svgRef} className="build-profile-chart" viewBox="0 0 640 570" role="img" aria-labelledby={`${id}-title ${id}-desc`}
        style={{ width: "100%", height: "auto", display: "block", color: "var(--ov-accent, #53d6d1)" }}>
        <title id={`${id}-title`}>Five-axis build profile, ratings from 1 to 5</title>
        <desc id={`${id}-desc`}>
          {BUILD_PROFILE_AXES.map((axis) => `${profile.labels[axis.key]}: ${profile.ratings[axis.key] ?? "not rated"}${profile.ratings[axis.key] === null ? "" : " out of 5"}`).join("; ")}
          . Higher means more of the named property. Personal assessments; not measured win rates.
        </desc>
        <g aria-hidden="true">
          {[1, 2, 3, 4, 5].map((level) => <polygon key={level} points={polygon(level / 5)} fill="none"
            stroke="#b7c9df" strokeOpacity={level === 5 ? 0.38 : 0.18} strokeWidth={1} />)}
          {BUILD_PROFILE_AXES.map((axis, index) => {
            const p = point(index, 1);
            return <line key={axis.key} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#b7c9df" strokeOpacity={0.18} />;
          })}
          {[1, 3, 5].map((level) => <text key={level} x={cx + 8} y={cy - radius * level / 5 + 5}
            fill="#a7b9ce" fontSize={17} fontFamily="inherit">{level}</text>)}
          {complete ? <polygon data-testid="build-profile-area" points={BUILD_PROFILE_AXES.map((axis, index) => {
            const p = point(index, profile.ratings[axis.key]! / 5);
            return `${p.x},${p.y}`;
          }).join(" ")} fill="currentColor" fillOpacity={0.24} stroke="currentColor" strokeWidth={3} strokeLinejoin="round" /> : null}
          {BUILD_PROFILE_AXES.map((axis, index) => {
            const value = profile.ratings[axis.key];
            const anchor = anchors[index];
            const lines = wrapLabel(profile.labels[axis.key]);
            const p = value === null ? null : point(index, value / 5);
            return <g key={axis.key}>
              {complete && p ? <circle data-testid="build-profile-point" cx={p.x} cy={p.y} r={5} fill="currentColor" /> : null}
              <text x={anchor.x} y={anchor.y} textAnchor="middle" fill="#eaf1fa" fontFamily="inherit" fontSize={24} fontWeight={500}>
                {lines.map((line, i) => <tspan className="profile-label-line" key={i} x={anchor.x} dy={i ? 28 : 0}>{line}</tspan>)}
                <tspan x={anchor.x} dy={34} fill="#eaf1fa" fontSize={29} fontWeight={600}>{value === null ? "—" : `${value}/5`}</tspan>
              </text>
            </g>;
          })}
          {!complete ? <text x={cx} y={cy + 6} textAnchor="middle" fill="#b7c9df" fontFamily="inherit" fontSize={22}>Rate all five points</text> : null}
        </g>
      </svg>
      <div style={{ fontSize: 22, color: "#b7c9df", textAlign: "center", lineHeight: 1.3 }}>
        {preview ? "Preview ratings · 1–5" : "Personal ratings · 1–5"}
      </div>
    </section>
  );
}

function ConnectedBuildProfileWidget({ token, studioEvent }: {
  token: string;
  studioEvent?: unknown;
}) {
  const state = useStudioState(token, studioEvent ?? null);
  const profile = state.buildProfile;
  if (!state.snapshotReady || !profile.visible || !isBuildProfileComplete(profile)) {
    return <div data-testid="build-profile-hidden" style={{ background: "transparent" }} />;
  }
  return <BuildProfileChart profile={profile} />;
}

const cardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 800,
  background: "var(--ov-panel-bg, #0c182bef)",
  border: "var(--ov-shell-border, 1px solid #28435c)",
  borderRadius: "var(--ov-radius, 16px)",
  padding: "24px 20px 22px",
  color: "#eaf1fa",
  fontFamily: "var(--ov-font, Segoe UI, ui-sans-serif, system-ui, sans-serif)",
};

export const BuildProfileWidget = withOverlayDemo(ConnectedBuildProfileWidget);
