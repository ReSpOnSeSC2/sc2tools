"use client";

import { useId, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { formatGameClock } from "@/lib/macro";

/**
 * ApmSpmChart — APM / SPM (Selection-per-minute) curves per player.
 *
 * Reads /v1/games/:id/apm-curve which returns up to two players, each
 * with a `{t, apm, spm}[]` sliding-window sample stream. We render
 * solid APM and dashed SPM, one colour per player. When `has_data` is
 * false (older replays, command/selection streams unparseable) we
 * surface an empty state rather than mocking values.
 */

export interface ApmCurvePlayer {
  name?: string | null;
  race?: string | null;
  samples: Array<{ t: number; apm?: number; spm?: number }>;
}

export interface ApmCurveData {
  ok: boolean;
  game_length_sec?: number;
  window_sec?: number;
  has_data?: boolean;
  players: ApmCurvePlayer[];
}

export interface ApmSpmChartProps {
  data: ApmCurveData | null | undefined;
  /** Hint used to colour the user's curve (matches their race accent). */
  myPlayerName?: string | null;
  myRace?: string | null;
}

const VIEW_W = 720;
const VIEW_H = 220;
const PAD_LEFT = 44;
const PAD_RIGHT = 24;
const PAD_TOP = 14;
const PAD_BOTTOM = 28;
const X_TICK_STEP_SEC = 60;
const Y_TICK_FRACS = [0, 0.25, 0.5, 0.75, 1];

const COLOR_AXIS = "rgb(var(--text-dim))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_YOU = "rgb(var(--success))";
const COLOR_OPP = "rgb(var(--danger))";

function maxOf(arr: number[]): number {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
}

function buildPath(
  samples: ApmCurvePlayer["samples"],
  key: "apm" | "spm",
  xMax: number,
  yMax: number,
  plotW: number,
  plotH: number,
): string {
  if (!samples.length || xMax <= 0 || yMax <= 0) return "";
  const xAt = (t: number) => PAD_LEFT + (t / xMax) * plotW;
  const yAt = (v: number) =>
    PAD_TOP + plotH - (Math.min(v, yMax) / yMax) * plotH;
  let d = "";
  for (let i = 0; i < samples.length; i += 1) {
    const t = Number(samples[i].t) || 0;
    const v = Number(samples[i][key]) || 0;
    d += (i === 0 ? "M " : " L ") + xAt(t).toFixed(2) + " " + yAt(v).toFixed(2);
  }
  return d;
}

export function ApmSpmChart({ data, myPlayerName, myRace }: ApmSpmChartProps) {
  const chartId = useId();

  const layout = useMemo(() => {
    if (!data || data.has_data === false) return null;
    const players = (data.players || []).filter(
      (p) => Array.isArray(p.samples) && p.samples.length > 0,
    );
    if (players.length === 0) return null;
    let xMax = 0;
    let yMax = 0;
    for (const p of players) {
      const ts = p.samples.map((s) => Number(s.t) || 0);
      const apms = p.samples.map((s) => Number(s.apm) || 0);
      const spms = p.samples.map((s) => Number(s.spm) || 0);
      const tMax = maxOf(ts);
      if (tMax > xMax) xMax = tMax;
      const vMax = Math.max(maxOf(apms), maxOf(spms));
      if (vMax > yMax) yMax = vMax;
    }
    if (data.game_length_sec && data.game_length_sec > xMax) {
      xMax = data.game_length_sec;
    }
    xMax = Math.max(60, xMax);
    yMax = Math.max(50, Math.ceil(yMax / 50) * 50);
    const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
    const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
    const xTicks: number[] = [];
    for (let t = 0; t <= xMax; t += X_TICK_STEP_SEC) xTicks.push(t);
    return { players, xMax, yMax, plotW, plotH, xTicks };
  }, [data]);

  if (!layout) return <ChartEmptyState />;

  const myIdx = (() => {
    if (!myPlayerName) return -1;
    const target = myPlayerName.toLowerCase();
    return layout.players.findIndex(
      (p) => (p.name || "").toLowerCase() === target,
    );
  })();

  return (
    <figure className="space-y-2" aria-labelledby={`${chartId}-title`}>
      <figcaption
        id={`${chartId}-title`}
        className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text">
          APM / SPM
        </span>
        <span className="text-[11px] text-text-dim">
          {data?.window_sec
            ? `Sliding window · ${data.window_sec}s`
            : "Sliding window"}
          {myRace ? ` · ${myRace}` : ""}
        </span>
      </figcaption>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated">
        <svg
          role="img"
          aria-label="Actions per minute and selections per minute over game time"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block h-[200px] w-full min-w-[320px] sm:h-[220px] sm:min-w-[480px]"
        >
          {Y_TICK_FRACS.map((f, i) => {
            const y = PAD_TOP + (1 - f) * layout.plotH;
            return (
              <g key={`y-${i}`}>
                <line
                  x1={PAD_LEFT}
                  y1={y}
                  x2={VIEW_W - PAD_RIGHT}
                  y2={y}
                  stroke={COLOR_GRID}
                  strokeDasharray="2 4"
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill={COLOR_AXIS}
                >
                  {Math.round(f * layout.yMax)}
                </text>
              </g>
            );
          })}
          {layout.xTicks.map((t, i) => {
            const x = PAD_LEFT + (t / layout.xMax) * layout.plotW;
            return (
              <g key={`x-${i}`}>
                <line
                  x1={x}
                  y1={PAD_TOP + layout.plotH}
                  x2={x}
                  y2={PAD_TOP + layout.plotH + 4}
                  stroke={COLOR_AXIS}
                  strokeOpacity="0.6"
                />
                <text
                  x={x}
                  y={VIEW_H - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fill={COLOR_AXIS}
                >
                  {formatGameClock(t)}
                </text>
              </g>
            );
          })}
          {layout.players.map((p, idx) => {
            const isMine = idx === myIdx || (myIdx === -1 && idx === 0);
            const color = isMine ? COLOR_YOU : COLOR_OPP;
            const apmPath = buildPath(
              p.samples,
              "apm",
              layout.xMax,
              layout.yMax,
              layout.plotW,
              layout.plotH,
            );
            const spmPath = buildPath(
              p.samples,
              "spm",
              layout.xMax,
              layout.yMax,
              layout.plotW,
              layout.plotH,
            );
            return (
              <g key={`p-${idx}`}>
                {apmPath ? (
                  <path
                    d={apmPath}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.6"
                    opacity="0.95"
                  />
                ) : null}
                {spmPath ? (
                  <path
                    d={spmPath}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.4"
                    strokeDasharray="3 3"
                    opacity="0.9"
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <Legend players={layout.players} myIdx={myIdx} />
    </figure>
  );
}

function Legend({
  players,
  myIdx,
}: {
  players: ApmCurvePlayer[];
  myIdx: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
      {players.map((p, idx) => {
        const isMine = idx === myIdx || (myIdx === -1 && idx === 0);
        const color = isMine ? COLOR_YOU : COLOR_OPP;
        const role = isMine ? "you" : "opp";
        const name = p.name || (isMine ? "You" : "Opponent");
        return (
          <span key={`leg-${idx}`} className="inline-flex items-center gap-2">
            <svg width="22" height="6" aria-hidden>
              <line x1="1" y1="3" x2="21" y2="3" stroke={color} strokeWidth="2" />
            </svg>
            <span>
              {name} APM <span className="text-text-dim">({role})</span>
            </span>
            <svg width="22" height="6" aria-hidden>
              <line
                x1="1"
                y1="3"
                x2="21"
                y2="3"
                stroke={color}
                strokeWidth="2"
                strokeDasharray="3 3"
              />
            </svg>
            <span className="text-text-dim">SPM</span>
          </span>
        );
      })}
    </div>
  );
}

function ChartEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        APM / SPM samples unavailable
      </div>
      <p className="text-caption text-text-muted">
        The activity curve hasn&apos;t been computed for this replay yet. Trigger
        a recompute to ask the agent to walk the command + selection event
        streams.
      </p>
    </div>
  );
}
