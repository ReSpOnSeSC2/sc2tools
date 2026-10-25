"use client";

import { Card, Stat } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { pct1 } from "@/lib/format";
import { timingDisplay } from "@/lib/dossierTimings";
import { hasPlanSurvival, type BuildPlan, type PlanLabel } from "@/lib/buildDossierInsights";

const winRate = (value: number | null) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? pct1(value) : "Unavailable";
function RankedLabels({ title, rows, onSelect }: { title: string; rows: PlanLabel[]; onSelect: (ids: string[], label: string) => void }) {
  return <div className="min-w-0"><h4 className="mb-2 text-caption font-semibold">{title}</h4>{rows.length ? <ol className="space-y-1">{rows.slice(0, 5).map(row => <li key={row.name}><button type="button" disabled={!row.sampleGameIds.length} onClick={() => onSelect(row.sampleGameIds, `${title}: ${row.name}`)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"><span className="min-w-0 break-words">{row.name}</span><span className="shrink-0 text-text-muted">{row.count} games</span><span className="w-full text-micro text-text-dim">{row.sampleGameIds.length ? `Inspect ${row.sampleGameIds.length}${row.sampleTruncated ? " latest" : ""} recorded examples` : "Recorded examples unavailable"}</span></button></li>)}</ol> : <p className="text-caption text-text-muted">No different labels recorded.</p>}</div>;
}

export function PlanSurvivalCard({ plan, onSelect }: { plan?: BuildPlan | null; onSelect: (ids: string[], label: string) => void }) {
  if (!hasPlanSurvival(plan)) return null;
  const held = plan.held / plan.declared;
  return <Card title="Plan survival" right={<LazyHelpLink slug="build-check-in" anchor="plan-survival" variant="icon" />}>
    <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
      <div className="flex items-center gap-4"><div role="img" aria-label={`${plan.held} held and ${plan.knockedOff} knocked off among ${plan.declared} declared games`} className="relative h-24 w-24 shrink-0 rounded-full" style={{ background: `conic-gradient(rgb(var(--accent)) ${held * 100}%, rgb(var(--text-dim) / .3) 0)` }}><span className="absolute inset-3 flex items-center justify-center rounded-full bg-bg-surface text-caption font-semibold">{pct1(held)}</span></div><div className="space-y-1 text-caption"><p><strong>{plan.held}</strong> held</p><p><strong>{plan.knockedOff}</strong> knocked off</p><p className="text-micro text-text-muted">{plan.declared} declared games</p></div></div>
      <div className="grid grid-cols-2 gap-3"><div><Stat label="Held win rate" value={winRate(plan.heldWR)} /><p className="mt-1 text-micro text-text-muted">{plan.heldDecided} decided games</p></div><div><Stat label="Knocked-off win rate" value={winRate(plan.knockedOffWR)} /><p className="mt-1 text-micro text-text-muted">{plan.knockedOffDecided} decided games</p></div></div>
    </div>
    <p className="my-4 text-caption text-text-muted">Held means the detector recorded the declared build or no different build. A different label is described as knocked off; it does not prove why your plan changed or how well you executed it.</p>
    <div className="grid gap-4 md:grid-cols-2"><RankedLabels title="Knocked into" rows={plan.knockedInto} onSelect={onSelect} /><RankedLabels title="Knocked by opponent strategy" rows={plan.knockedBy} onSelect={onSelect} /></div>
    <p className="mt-4 text-micro text-text-dim">{plan.medianKnockedOffDurationSec === null ? "Game-duration estimate unavailable." : `Estimated median full game length when knocked off: ${timingDisplay(plan.medianKnockedOffDurationSec)} (${plan.durationSamples} measured games).`} This is not the time the plan changed. Ranked counts cover all declared games; links show at most 20 latest recorded examples.</p>
  </Card>;
}
