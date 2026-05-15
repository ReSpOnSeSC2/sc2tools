"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import {
  fmtTick,
  type GameTick,
  type TechPathBlock,
} from "./shared/snapshotTypes";

// Tech-path timeline — Sankey-flavored on desktop, vertical list
// on mobile. The user's actual path is rendered as an amber row
// across the timeline; each decision-building addition appears as
// a labeled node at the tick it was completed. Click/tap any node
// pins the cursor via the shared focus handler.
//
// Mobile (<sm) collapses to a stacked list of "key decisions" so
// the horizontal Sankey doesn't crowd 375px. The desktop view
// shows the cohort's top-3 winning paths as muted-green parallel
// lanes underneath the user's row for direct comparison.

const LANE_HEIGHT = 32;

export interface TechPathTimelineProps {
  ticks: GameTick[];
  focusedTick: number | null;
  onFocus: (t: number) => void;
}

export function TechPathTimeline({ ticks, focusedTick, onFocus }: TechPathTimelineProps) {
  const userTimeline = useMemo(() => deriveUserTimeline(ticks), [ticks]);
  const winnerLanes = useMemo(() => deriveWinnerLanes(ticks), [ticks]);

  if (userTimeline.nodes.length === 0 && winnerLanes.length === 0) {
    return (
      <Card title="Tech path">
        <p className="py-4 text-center text-caption text-text-dim">
          Not enough decision-point data yet.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Tech path">
      <Card.Body>
        {/* Desktop horizontal lanes */}
        <div className="hidden sm:block">
          <DesktopLanes
            user={userTimeline}
            winners={winnerLanes}
            focusedTick={focusedTick}
            onFocus={onFocus}
          />
        </div>
        {/* Mobile vertical list */}
        <div className="sm:hidden">
          <MobileList user={userTimeline} winners={winnerLanes} onFocus={onFocus} focusedTick={focusedTick} />
        </div>
      </Card.Body>
    </Card>
  );
}

interface TimelineNode {
  t: number;
  building: string;
  label: string;
  winRate: number;
  sampleSize: number;
}

interface UserTimeline {
  nodes: TimelineNode[];
  finalPathLabel: string;
}

interface WinnerLane {
  pathId: string;
  label: string;
  frequency: number;
  winRate: number;
  nodes: TimelineNode[];
}

function deriveUserTimeline(ticks: GameTick[]): UserTimeline {
  const seen = new Set<string>();
  const nodes: TimelineNode[] = [];
  let finalPathLabel = "";
  for (const tick of ticks) {
    const tp = tick.techPath;
    if (!tp) continue;
    finalPathLabel = tp.pathLabel;
    for (const b of tp.buildingsInPath) {
      if (seen.has(b)) continue;
      seen.add(b);
      nodes.push({
        t: tick.t,
        building: b,
        label: tp.pathLabel,
        winRate: tp.pathWinRate,
        sampleSize: tp.sampleSize,
      });
    }
  }
  return { nodes, finalPathLabel };
}

function deriveWinnerLanes(ticks: GameTick[]): WinnerLane[] {
  const lanes = new Map<string, WinnerLane>();
  for (const tick of ticks) {
    const tp = tick.techPath;
    if (!tp) continue;
    for (const alt of tp.alternatives) {
      if (lanes.has(alt.pathId)) continue;
      if (alt.frequency < 0.1 || (alt.sampleSize ?? alt.total ?? 0) < 8) continue;
      lanes.set(alt.pathId, {
        pathId: alt.pathId,
        label: alt.label,
        frequency: alt.frequency,
        winRate: alt.winRate,
        nodes: [],
      });
    }
  }
  return Array.from(lanes.values()).slice(0, 3);
}

function DesktopLanes({
  user,
  winners,
  focusedTick,
  onFocus,
}: {
  user: UserTimeline;
  winners: WinnerLane[];
  focusedTick: number | null;
  onFocus: (t: number) => void;
}) {
  return (
    <div className="space-y-3">
      <Lane
        label={user.finalPathLabel ? `You · ${user.finalPathLabel}` : "You"}
        accent="#fbbf24"
        nodes={user.nodes}
        focusedTick={focusedTick}
        onFocus={onFocus}
      />
      {winners.map((w) => (
        <Lane
          key={w.pathId}
          label={`${w.label} · ${Math.round(w.winRate * 100)}% wins`}
          accent="rgba(34, 197, 94, 0.55)"
          subtle
          nodes={w.nodes}
          focusedTick={focusedTick}
          onFocus={onFocus}
        />
      ))}
    </div>
  );
}

function Lane({
  label,
  accent,
  nodes,
  focusedTick,
  onFocus,
  subtle,
}: {
  label: string;
  accent: string;
  nodes: TimelineNode[];
  focusedTick: number | null;
  onFocus: (t: number) => void;
  subtle?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-caption text-text-muted">
        <span style={{ color: subtle ? undefined : accent }}>{label}</span>
      </div>
      <div
        className="relative rounded-md border border-border bg-bg-elevated"
        style={{ height: LANE_HEIGHT }}
      >
        <div className="absolute inset-y-1/2 left-0 right-0 h-px" style={{ background: accent }} />
        {nodes.map((node) => {
          const left = `${(node.t / 1200) * 100}%`;
          const isFocused = focusedTick === node.t;
          return (
            <button
              key={`${node.building}-${node.t}`}
              type="button"
              onClick={() => onFocus(node.t)}
              aria-label={`${node.building} added at ${fmtTick(node.t)}`}
              className={[
                "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                isFocused ? "border-accent text-accent" : "border-border text-text",
              ].join(" ")}
              style={{ left, background: "rgb(var(--bg-surface))" }}
            >
              {node.building}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MobileList({
  user,
  winners,
  onFocus,
  focusedTick,
}: {
  user: UserTimeline;
  winners: WinnerLane[];
  onFocus: (t: number) => void;
  focusedTick: number | null;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="mb-1 text-caption font-semibold text-text">Your key decisions</h4>
        {user.nodes.length === 0 ? (
          <p className="text-caption text-text-dim">No decision buildings yet.</p>
        ) : (
          <ul className="space-y-1">
            {user.nodes.map((n) => (
              <li key={`${n.building}-${n.t}`}>
                <button
                  type="button"
                  onClick={() => onFocus(n.t)}
                  aria-pressed={focusedTick === n.t}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-left text-caption"
                >
                  <span className="font-medium text-text">{n.building}</span>
                  <span className="text-text-muted">{fmtTick(n.t)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {winners.length > 0 ? (
        <div>
          <h4 className="mb-1 text-caption font-semibold text-text">Cohort winners' top paths</h4>
          <ul className="space-y-1 text-[12px] text-text-muted">
            {winners.map((w) => (
              <li key={w.pathId} className="flex items-center justify-between">
                <span>{w.label}</span>
                <span className="font-semibold text-success">{Math.round(w.winRate * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
