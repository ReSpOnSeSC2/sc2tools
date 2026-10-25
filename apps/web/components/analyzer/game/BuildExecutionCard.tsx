"use client";
import { useMemo } from "react";
import { CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { PracticeButton } from "@/components/practice/PracticeButton";
import { replayOrderTarget } from "@/lib/practiceTarget";
import type { BuildExecution, ExecutionTiming } from "@/lib/buildExecution";
import { checkedMatchPercentage } from "@/lib/buildExecution";
import { timingDisplay } from "@/lib/dossierTimings";
import type { GameBuildOrderEvent } from "./types";

type Props = { data?: BuildExecution; gameId: string; events?: GameBuildOrderEvent[] | null;
  loading?: boolean; error?: unknown; unavailable?: boolean; onRetry?: () => unknown; onSeek?: (seconds: number) => void };

export function BuildExecutionCard({ data, gameId, events, loading, error, unavailable, onRetry, onSeek }: Props) {
  const target = useMemo(() => data?.build && events?.length ? replayOrderTarget(data.build.name, events, gameId) : null, [data?.build, events, gameId]);
  if (error) return <RequestError title="Build evidence couldn't be loaded" error={error} onRetry={onRetry} />;
  const help = <LazyHelpLink slug="build-check-in" anchor="grading-a-game">How is this checked?</LazyHelpLink>;
  if (loading) return <Card title="Build execution" right={help}><div role="status" className="h-28 animate-pulse rounded bg-bg-elevated motion-reduce:animate-none">Loading recorded build evidence…</div></Card>;
  if (unavailable || data?.unavailable === "log_missing") return <Card title="Build execution" right={help}><p className="text-caption text-text-muted">Build evidence is unavailable for this replay. Rules are unknown until an own build log is extracted; no percentage is shown.</p></Card>;
  if (!data?.build) return <Card title="Build execution" right={help}><p className="text-caption text-text-muted">Check in a build to grade this game.</p></Card>;
  if (data.unavailable === "resumed" || data.build.deleted) return <Card title="Build execution" right={help}><p className="text-caption text-text-muted">{data.build.deleted ? "This build definition is no longer available." : "A resumed replay has no build execution comparison."} No percentage is shown.</p></Card>;
  const percentage = checkedMatchPercentage(data);
  return <Card title="Build execution" right={help} aria-label="Private build execution evidence">
    <div className="flex flex-wrap items-center gap-4">
      {data.ruleCount > 0 ? <div role="img" aria-label={`${data.passedCount} observed passes, ${data.knownCount - data.passedCount} unmet rules and ${data.ruleCount - data.knownCount} unknown rules`} className="grid h-20 w-20 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(var(--color-success) 0 ${100 * data.passedCount / data.ruleCount}%, var(--color-danger) 0 ${100 * data.knownCount / data.ruleCount}%, var(--color-border) 0)` }}><span className="grid h-14 w-14 place-items-center rounded-full bg-bg-surface text-caption font-semibold">{percentage === null ? "—" : `${Math.round(percentage)}%`}</span></div> : null}
      <div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{data.build.name}{data.ruleCount ? ` — ${data.passedCount}/${data.ruleCount} rules` : ""}</h3>
        <p className="mt-1 text-caption text-text-muted">{data.source === "confirmed" ? "Confirmed check-in" : "Recorded detected build"} · {data.matchup || "Matchup unknown"}</p>
        {data.ruleCount && percentage === null ? <p className="mt-1 text-caption text-text-muted">{data.ruleCount - data.knownCount} {data.ruleCount - data.knownCount === 1 ? "rule" : "rules"} unknown. Overall percentage withheld.</p> : null}
        {!data.ruleCount ? <p className="mt-1 text-caption text-text-muted">{data.build.source === "catalog" ? "Catalog builds show timings only." : "This build has no rules yet."} No rule grade is calculated.</p> : null}
      </div>
    </div>
    <p className="mt-3 text-micro text-text-muted">Fixed rules describe the recorded events before their deadlines. They do not judge your decisions or explain the result. Deadline chips mark a window boundary, not a recorded action.</p>
    {data.rules.length ? <ul className="mt-4 space-y-2" aria-label="Build rule evidence">{data.rules.map(rule => {
      const Mark = rule.unavailable ? HelpCircle : rule.pass ? CheckCircle2 : XCircle;
      const state = rule.unavailable ? "Unknown" : rule.pass ? "Observed" : "Unmet";
      return <li key={rule.index} className="flex flex-wrap items-start gap-2 rounded-lg border border-line p-3"><Mark className={`mt-1 h-4 w-4 shrink-0 ${rule.unavailable ? "text-text-muted" : rule.pass ? "text-success" : "text-danger"}`} aria-label={state} /><p className="min-w-0 flex-1 basis-40 text-caption">{rule.sentence}</p>
        {typeof rule.evidenceSec === "number" && Number.isFinite(rule.evidenceSec) ? <button type="button" disabled={!onSeek} onClick={() => onSeek?.(rule.evidenceSec!)} className="min-h-11 rounded border border-line px-3 text-caption font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{rule.evidenceKind === "deadline" ? "Deadline " : "At "}{timingDisplay(rule.evidenceSec)}</button> : <span className="self-center text-micro text-text-muted">Unknown</span>}
      </li>;
    })}</ul> : null}
    <div className="mt-5"><h3 className="text-caption font-semibold">Key timings vs your usual</h3>
      <p className="mt-1 text-micro text-text-muted">Same build and matchup · latest {data.timingSampleSelected} eligible games (up to {data.timingSampleLimit}); {data.timingSampleGames} recorded timing logs. Middle half = p25–p75. Construction starts only; a natural is the first town hall after 0:10.</p>
      {!data.timings.length ? <p className="mt-2 text-caption text-text-muted">No supported building milestones were recorded in this game.</p> : !data.timings.some(row => row.medianSec !== null) ? <p className="mt-2 text-caption text-text-muted">Timings appear after {data.timingMinSample} games with the same recorded milestone.</p> : null}
      <ul className="mt-3 space-y-2" aria-label="Build timing comparisons">{data.timings.map(row => <TimingRow key={row.token} value={row} onSeek={onSeek} />)}</ul>
    </div>
    {target ? <div className="mt-4 flex flex-wrap items-center gap-3"><span className="text-caption font-semibold">Practice this build</span><PracticeButton build={{ ...data.build, sourceGameId: gameId }} target={target} privateBuild={data.build.source === "custom"} /></div> : null}
  </Card>;
}

function TimingRow({ value, onSeek }: { value: ExecutionTiming; onSeek?: (seconds: number) => void }) {
  const { thisGameSec: current, medianSec: median, p25Sec: lo, p75Sec: hi } = value;
  const max = Math.max(current, hi ?? 0, median ?? 0, 60) * 1.1;
  const delta = typeof value.deltaSec === "number" ? Math.round(value.deltaSec) : null;
  const kind = value.kind === "natural" ? "Natural" : value.kind === "first_gas" ? "First gas" : value.kind === "first_tech" ? "First tech" : null;
  return <li className="rounded-lg border border-line p-3"><button type="button" disabled={!onSeek} onClick={() => onSeek?.(current)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span className="text-caption font-semibold">{kind ? `${kind} · ` : ""}{value.displayName}</span><span className="text-caption tabular-nums">{timingDisplay(current)} <span className="text-text-muted">· n={value.n}</span></span></button>
    <div className="relative my-2 h-2 rounded-full bg-bg-elevated" role="img" aria-label={median === null ? "Usual timing unavailable" : `Middle half ${timingDisplay(lo ?? median)} to ${timingDisplay(hi ?? median)}; your median ${timingDisplay(median)}; this game ${timingDisplay(current)}`}>
      {median !== null && lo !== null && hi !== null ? <span className="absolute top-0 h-2 rounded bg-accent/30" style={{ left: `${100 * lo / max}%`, width: `${Math.max(1, 100 * (hi - lo) / max)}%` }} /> : null}
      {median !== null ? <span className="absolute -top-1 h-4 w-0.5 bg-text-muted" style={{ left: `${100 * median / max}%` }} /> : null}
      <span className="absolute -top-1 h-4 w-1 rounded bg-accent" style={{ left: `${100 * current / max}%` }} />
    </div><p className="text-micro text-text-muted">{median === null || delta === null ? "Comparison unavailable at this sample size." : <>Your usual {timingDisplay(median)} · <span className={delta > 0 ? "text-danger" : delta < 0 ? "text-success" : "text-text"}>{delta === 0 ? "same timing" : `${Math.abs(delta)}s ${delta > 0 ? "later" : "earlier"}`}</span></>}</p>
  </li>;
}
