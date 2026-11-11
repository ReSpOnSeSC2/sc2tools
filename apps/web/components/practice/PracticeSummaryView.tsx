"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import {
  DEFAULT_WEEKLY_GOAL,
  DRIFT_WINDOW,
  SPARKLINE_GAMES,
  clock,
  driftText,
  gradeShares,
  gradeSparkline,
  rollingDrift,
  weekProgress,
  type PracticeStepStat,
  type PracticeSummary,
} from "@/lib/practiceLog";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PracticeGamesList } from "./PracticeGamesList";
import { CheckpointEditor, CheckpointResults } from "./CheckpointEditor";
import { GRADE_TEXT_CLASS } from "./gradeStyles";

export function PracticeSummaryView({ summary, matchup, onSelectTarget, onGraded }: {
  summary: PracticeSummary;
  matchup: string;
  onSelectTarget: (hash: string | null) => void;
  onGraded: () => void;
}) {
  const target = summary.target;
  return (
    <div className="space-y-5">
      <TargetCard summary={summary} matchup={matchup} onSelectTarget={onSelectTarget} onGraded={onGraded} />
      {target?.current && target.steps?.length ? (
        <CheckpointEditor key={`${matchup}:${target.hash}`} matchup={matchup} targetHash={target.hash}
          steps={target.steps} checkpoints={summary.checkpoints ?? []} onSaved={onGraded} />
      ) : summary.checkpoints?.length ? (
        <Card title="Checkpoints"><CheckpointResults checkpoints={summary.checkpoints} /></Card>
      ) : null}
      {summary.sample.graded === 0 ? (
        <p role="status" className="rounded-lg border border-border p-4 text-caption text-text-muted">
          No graded {matchup} games for this target yet. Play a {matchup} game, or grade your recent ones above.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <GradeTrend summary={summary} />
            <WeeklyPlan summary={summary} />
          </div>
          {summary.steps ? <StepDrift steps={summary.steps} /> : null}
          <FallOff summary={summary} />
        </>
      )}
      {target ? <PracticeGamesList key={`${matchup}:${target.hash}:${summary.sample.graded}:${summary.sample.ungraded}`} matchup={matchup} targetHash={target.hash} /> : null}
    </div>
  );
}

function TargetCard({ summary, matchup, onSelectTarget, onGraded }: Parameters<typeof PracticeSummaryView>[0]) {
  const { getToken } = useAuth();
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>({ busy: false, message: null, error: false });
  const target = summary.target;
  const earlier = summary.targets.filter((entry) => entry.hash !== target?.hash);
  const gradeRecent = async () => {
    setState({ busy: true, message: null, error: false });
    try {
      const result = await apiCall<{ graded: number; considered: number }>(getToken, "/v1/practice/grade-recent", { method: "POST", body: JSON.stringify({ matchup }) });
      const message = result.graded ? `Graded ${result.graded} of your recent ${matchup} games.`
        : result.considered ? `Your ungraded ${matchup} games are missing build logs.` : `No ungraded recent ${matchup} games to grade.`;
      setState({ busy: false, error: false, message });
      onGraded();
    } catch {
      setState({ busy: false, error: true, message: "Couldn't grade your recent games. Try again." });
    }
  };
  return (
    <Card title={target?.current ? `${matchup} target` : `${matchup} earlier target`}>
      <div className="space-y-3">
        <p className="text-body font-medium text-text">{target?.name ?? "Unnamed target"}</p>
        <p className="text-caption text-text-muted">
          {target?.current
            ? target.armedAt ? `Armed ${new Date(target.armedAt).toLocaleDateString()}. Games you play in ${matchup} from then on are graded against it.` : `Games you play in ${matchup} are graded against it.`
            : "No longer armed. Its graded games stay in your log."}
          {" "}{summary.sample.graded} graded{summary.sample.ungraded ? `, ${summary.sample.ungraded} without a build log` : ""}{summary.sample.capped ? ` (latest ${summary.sample.limit})` : ""}.
        </p>
        {earlier.length > 0 || !target?.current ? (
          <label className="flex flex-col gap-1 text-caption text-text-muted sm:flex-row sm:items-center sm:gap-3">
            Target
            <select value={target?.hash ?? ""} onChange={(event) => onSelectTarget(summary.targets.find((entry) => entry.hash === event.target.value && !entry.current) ? event.target.value : null)}
              className="min-h-11 rounded-md border border-border-strong bg-bg-elevated px-2 text-caption text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {summary.targets.map((entry) => (
                <option key={entry.hash} value={entry.hash}>{entry.name ?? "Unnamed"}{entry.current ? " (armed)" : ` · ${entry.games} games`}</option>
              ))}
            </select>
          </label>
        ) : null}
        {target?.current ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" loading={state.busy} onClick={() => void gradeRecent()}>Grade my last 20 games</Button>
            {state.message ? <p role={state.error ? "alert" : "status"} className={`text-caption ${state.error ? "text-danger" : "text-text-muted"}`}>{state.message}</p> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function GradeTrend({ summary }: { summary: PracticeSummary }) {
  const points = gradeSparkline(summary.history);
  const shares = gradeShares(summary.grades);
  const width = 300;
  const height = 96;
  const pad = 10;
  const at = (point: { x: number; y: number }) => ({ cx: 24 + point.x * (width - 24 - pad), cy: pad + point.y * (height - pad * 2) });
  return (
    <Card title={`Last ${Math.min(SPARKLINE_GAMES, points.length)} grades`}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" role="img"
        aria-label={`Grades, oldest to newest: ${points.map((point) => point.row.grade).join(", ")}`}>
        {(["S", "A", "B", "C", "D"] as const).map((grade, index) => {
          const y = pad + (index / 4) * (height - pad * 2);
          return (
            <g key={grade} aria-hidden>
              <line x1={24} x2={width - pad} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
              <text x={4} y={y + 4} className="fill-text-dim text-micro">{grade}</text>
            </g>
          );
        })}
        {points.length > 1 ? (
          <polyline aria-hidden fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round"
            points={points.map((point) => { const p = at(point); return `${p.cx},${p.cy}`; }).join(" ")} />
        ) : null}
        {points.map((point) => {
          const p = at(point);
          return (
            <circle key={point.row.gameId} cx={p.cx} cy={p.cy} r={4} aria-hidden
              className={point.row.via === "request" ? "fill-bg-surface stroke-accent" : "fill-accent stroke-bg-surface"} strokeWidth={2}>
              <title>{`${new Date(point.row.date).toLocaleDateString()}: ${point.row.grade}, ${point.row.matched}/${point.row.total} steps, ${point.row.avgDrift}s average drift${point.row.via === "request" ? " (graded on request)" : ""}`}</title>
            </circle>
          );
        })}
      </svg>
      <p className="text-micro text-text-dim">Hollow dots are games graded on request, played before you armed the target.</p>
      <DriftTrend summary={summary} />
      <ul className="mt-3 grid grid-cols-5 gap-2" aria-label="Grade distribution">
        {shares.map((entry) => (
          <li key={entry.grade} className="flex flex-col items-center gap-1 text-caption">
            <span className={`font-display text-h3 font-bold ${GRADE_TEXT_CLASS[entry.grade]}`}>{entry.grade}</span>
            <span className="tabular-nums text-text">{entry.games}</span>
            <span className="tabular-nums text-micro text-text-dim">{Math.round(entry.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DriftTrend({ summary }: { summary: PracticeSummary }) {
  const drift = rollingDrift(summary.history);
  if (drift.recent === null) return null;
  const change = drift.previous === null ? null : Math.round((drift.recent - drift.previous) * 10) / 10;
  return (
    <p className="mt-2 text-caption text-text-muted">
      Average drift over your last {Math.min(DRIFT_WINDOW, summary.history.length)} graded games: <span className="font-semibold tabular-nums text-text">{drift.recent}s</span>
      {change === null ? null : <> ({change === 0 ? "same as" : change < 0 ? `${-change}s tighter than` : `${change}s looser than`} the {DRIFT_WINDOW} before)</>}
    </p>
  );
}

function WeeklyPlan({ summary }: { summary: PracticeSummary }) {
  const [goal, setGoal] = useLocalStoragePositiveInt("practice.weeklyGoal", DEFAULT_WEEKLY_GOAL);
  const week = weekProgress(summary.history, new Date(), goal);
  return (
    <Card title="This week">
      <div className="space-y-3">
        <p className="text-body text-text">
          <span className="font-semibold tabular-nums">{week.good}</span> of {week.goal} games at B or better
          <span className="text-caption text-text-muted"> · {week.graded} graded this week</span>
        </p>
        <div role="progressbar" aria-label="Weekly practice goal" aria-valuemin={0} aria-valuemax={week.goal} aria-valuenow={Math.min(week.good, week.goal)}
          aria-valuetext={`${week.good} of ${week.goal} games at B or better`} className="h-3 overflow-hidden rounded-full bg-bg-elevated ring-1 ring-border">
          <div className="h-full rounded-full bg-accent motion-safe:transition-[width]" style={{ width: `${week.ratio * 100}%` }} />
        </div>
        <label className="flex min-h-11 items-center gap-3 text-caption text-text-muted">
          Weekly goal
          <input type="number" min={1} max={50} value={goal} inputMode="numeric"
            onChange={(event) => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= 50) setGoal(next); }}
            className="min-h-11 w-20 rounded-md border border-border-strong bg-bg-elevated px-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
          <span>games at B or better (saved on this device)</span>
        </label>
      </div>
    </Card>
  );
}

function StepDrift({ steps }: { steps: PracticeStepStat[] }) {
  const scale = Math.max(15, ...steps.map((step) => Math.abs(step.avgDrift ?? 0)));
  return (
    <Card title="Per-step timing">
      <p className="mb-3 text-caption text-text-muted">Average drift of each step in the games where you built it. Bars to the right are late, to the left early.</p>
      <ol className="space-y-1.5">
        {steps.map((step) => {
          const drift = step.avgDrift;
          const share = drift === null ? 0 : Math.min(1, Math.abs(drift) / scale) * 50;
          return (
            <li key={step.i} className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-caption sm:grid-cols-[3rem_minmax(0,12rem)_minmax(0,1fr)_8rem]">
              <span className="font-mono text-micro tabular-nums text-text-dim">{clock(step.t)}</span>
              <span className="truncate text-text" title={step.name}>{step.name}</span>
              <span aria-hidden className="relative col-span-2 h-2.5 rounded-full bg-bg-elevated sm:col-span-1">
                <span className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
                {drift !== null ? (
                  <span className="absolute inset-y-0 rounded-full bg-accent" style={drift >= 0 ? { left: "50%", width: `${share}%` } : { right: "50%", width: `${share}%` }} />
                ) : null}
              </span>
              <span className="col-span-2 tabular-nums text-text-muted sm:col-span-1 sm:text-right">
                {driftText(drift)} · {step.hit}/{step.games} games
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function FallOff({ summary }: { summary: PracticeSummary }) {
  const planned = new Map((summary.target?.steps ?? []).map((step) => [step.i, step.t]));
  return (
    <Card title="Where you fall off">
      {summary.divergence.length === 0 ? (
        <p className="text-caption text-text-muted">No step pulls you off the build: every graded game stayed within 30 seconds to the end.</p>
      ) : (
        <ol className="space-y-2">
          {summary.divergence.map((entry) => (
            <li key={entry.i} className="text-caption">
              <span className="font-medium text-text">{entry.name}</span>
              {planned.has(entry.i) ? <span className="text-text-muted"> (planned {clock(planned.get(entry.i)!)})</span> : null}
              <span className="text-text-muted"> — first slip in {entry.games} of {summary.sample.graded} games{entry.cut ? `, skipped in ${entry.cut}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
