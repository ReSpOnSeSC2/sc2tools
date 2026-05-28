"use client";

/**
 * Spinning wheel reveal — segments sized by the build's true landing
 * probability, so a streamer watching the visual sees an honest mirror
 * of the engine's weighting. Five turns plus the winner-aligning angle,
 * decelerating into the top pointer.
 */
import { useMemo } from "react";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import {
  MatchupPill,
  RevealFrame,
  WinnerCard,
  raceHex,
  rarityFor,
  useReducedMotion,
  useRevealStart,
  useRevealTimer,
  type RevealProps,
} from "./revealShared";

const DURATION_MS = 5000;
const RADIUS = 130;
const VIEWBOX = RADIUS * 2 + 20;

export function WheelSpinReveal({
  pool,
  probabilities,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const started = useRevealStart(spinId, reducedMotion);
  const settled = useRevealTimer(spinId, DURATION_MS, reducedMotion, onComplete);
  const rarity = rarityFor(winnerProbability);

  const { segments, targetRotation } = useMemo(
    () => buildSegments(pool, probabilities, winner, spinId),
    [pool, probabilities, winner, spinId],
  );

  // The wheel begins spinning the moment it mounts (`started`) and runs
  // the full duration; the winner card only appears once `settled`.
  const rotation = started ? targetRotation : 0;

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: VIEWBOX,
          height: VIEWBOX,
          maxWidth: "92vw",
        }}
      >
        <svg
          viewBox={`-${VIEWBOX / 2} -${VIEWBOX / 2} ${VIEWBOX} ${VIEWBOX}`}
          style={{ width: "100%", height: "100%", display: "block" }}
        >
          <g
            key={spinId}
            style={{
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "0 0",
              transition: reducedMotion
                ? "none"
                : `transform ${DURATION_MS}ms cubic-bezier(.18,.7,.2,1)`,
            }}
          >
            {segments.map((seg) => (
              <g key={seg.build.id}>
                <path
                  d={seg.path}
                  fill={seg.fill}
                  stroke="rgba(11,13,18,0.85)"
                  strokeWidth={1.5}
                />
                <text
                  x={seg.labelX}
                  y={seg.labelY}
                  fill="#e6e8ee"
                  fontSize={11}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${seg.labelRotation} ${seg.labelX} ${seg.labelY})`}
                  style={{ pointerEvents: "none" }}
                >
                  {truncate(seg.build.name, 18)}
                </text>
              </g>
            ))}
            <circle r={20} fill="#0b0d12" stroke="rgba(255,255,255,0.18)" />
          </g>
          {/* Pointer at the top — outside the rotating group. */}
          <polygon
            points={`0,${-RADIUS - 4} -10,${-RADIUS + 16} 10,${-RADIUS + 16}`}
            fill={settled ? rarity.color : "#e6b450"}
            stroke="rgba(11,13,18,0.9)"
            strokeWidth={1.5}
            style={{
              transition: "fill 250ms ease",
              filter: `drop-shadow(0 0 8px ${settled ? rarity.color : "#e6b45088"})`,
            }}
          />
        </svg>
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

interface Segment {
  build: RandomizerBuild;
  path: string;
  fill: string;
  labelX: number;
  labelY: number;
  labelRotation: number;
}

function buildSegments(
  pool: RandomizerBuild[],
  probabilities: number[],
  winner: RandomizerBuild,
  spinId: number,
): { segments: Segment[]; targetRotation: number } {
  // Degenerate guard — a single-build pool just stops on a full circle.
  if (pool.length === 0) {
    return { segments: [], targetRotation: 0 };
  }
  const segments: Segment[] = [];
  let acc = 0;
  let winnerCenter = 0;
  pool.forEach((b, i) => {
    const sweepDeg = probabilities[i] * 360;
    const startDeg = acc;
    const endDeg = acc + sweepDeg;
    const midDeg = startDeg + sweepDeg / 2;
    acc = endDeg;

    if (b.id === winner.id) winnerCenter = midDeg;

    const isFullCircle = sweepDeg >= 359.99;
    segments.push({
      build: b,
      path: isFullCircle ? fullCirclePath(RADIUS) : pathForSlice(RADIUS, startDeg, endDeg),
      fill: tintForRace(b.race, i),
      ...labelGeometry(RADIUS, midDeg),
    });
  });

  // Land the winner under the top pointer. Add ±half-sweep jitter so the
  // wheel doesn't always rest exactly at the same offset within a slice.
  const winnerSweep = (probabilities[pool.findIndex((b) => b.id === winner.id)] || 0) * 360;
  const jitterRange = Math.max(0, Math.min(winnerSweep / 2 - 2, 40));
  const seedRng = mulberry32Static(spinId);
  const jitter = (seedRng() * 2 - 1) * jitterRange;
  const targetWithinSlice = winnerCenter + jitter;
  const baseTurns = 360 * 5;
  const targetRotation = baseTurns + (360 - (((targetWithinSlice % 360) + 360) % 360));

  return { segments, targetRotation };
}

function pathForSlice(r: number, startDeg: number, endDeg: number): string {
  const sweep = endDeg - startDeg;
  const large = sweep > 180 ? 1 : 0;
  const [sx, sy] = polar(r, startDeg);
  const [ex, ey] = polar(r, endDeg);
  return `M 0 0 L ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

function fullCirclePath(r: number): string {
  return `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r} Z`;
}

function labelGeometry(r: number, midDeg: number) {
  const [lx, ly] = polar(r * 0.62, midDeg);
  // Rotate labels so they're roughly readable along the slice radius.
  let labelRotation = midDeg - 90;
  if (labelRotation > 90) labelRotation -= 180;
  if (labelRotation < -90) labelRotation += 180;
  return { labelX: lx, labelY: ly, labelRotation };
}

/** Convert (angle-clockwise-from-top, radius) to cartesian. */
function polar(r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(rad), r * Math.sin(rad)];
}

/** Race-tinted slice fill that alternates shade so neighbours differ. */
function tintForRace(race: string, index: number): string {
  const base = raceHex(race);
  return index % 2 === 0 ? base : shade(base, -0.22);
}

function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = clamp((num >> 16) + amount * 255);
  const g = clamp(((num >> 8) & 0xff) + amount * 255);
  const b = clamp((num & 0xff) + amount * 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function mulberry32Static(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
