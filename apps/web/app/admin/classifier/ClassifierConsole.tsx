"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { apiCall, useApi } from "@/lib/clientApi";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard, LoadingRows, MetricStat } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { ClassifierSamples } from "./ClassifierSamples";
import { AXIS_LABEL, ORIGIN_LABEL, engineLabel, type ClassifierConsoleResp, type ClassifierEngine, type ClassifierPair, type ClassifierOrigins } from "./classifierTypes";

const VIEWS = ["pairs", "confusion", "labels"] as const;
type View = (typeof VIEWS)[number];
const AXES = ["all", "build", "opponent"] as const;

/**
 * /admin/classifier — what confirmed check-ins say about detector labels:
 * disagreement pairs by volume, a confusion view per detected label, label
 * agreement, a per-engine trend and correction provenance. Every row has at
 * least the k-floor of distinct players; counts are disagreement volume,
 * never accuracy. Read-only: rules stay human-edited in Build Studio, and
 * the only write is the audited Recompute now job run.
 */
export function ClassifierConsole() {
  const { getToken } = useAuth();
  const [view, setView] = useAdminQueryState({ axis: "all", matchup: "", engine: "", tab: "pairs" }, { allowed: { axis: AXES, tab: VIEWS } });
  const [drill, setDrill] = useState<ClassifierPair | null>(null);
  const [recompute, setRecompute] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });
  const params = new URLSearchParams();
  if (view.axis !== "all") params.set("axis", view.axis);
  if (view.matchup) params.set("matchup", view.matchup);
  if (view.engine) params.set("engine", view.engine);
  const swr = useApi<ClassifierConsoleResp>(`/v1/admin/classifier${params.size ? `?${params}` : ""}`, { keepPreviousData: true, revalidateOnFocus: false });
  if (swr.error?.status === 403 || swr.error?.status === 401) return <ForbiddenCard />;
  const snapshot = swr.data?.snapshot ?? null;

  async function runNow() {
    if (recompute.busy) return;
    setRecompute({ busy: true, error: null });
    try {
      await apiCall(getToken, "/v1/admin/jobs/classifier-quality/run", { method: "POST" });
      await swr.mutate();
      setRecompute({ busy: false, error: null });
    } catch (error) {
      setRecompute({ busy: false, error });
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="classifier-console" title="Classifier"
        description="Where player check-ins disagree with the detected build label. Counts are disagreement volume from players who checked in, not an accuracy score."
        actions={<Button size="sm" variant="secondary" loading={recompute.busy} onClick={() => { void runNow(); }}>Recompute now</Button>} />
      {recompute.error ? <RequestError error={recompute.error} onRetry={() => { void runNow(); }} /> : null}
      {swr.error ? <RequestError error={swr.error} onRetry={() => void swr.mutate()} /> : !swr.data ? <LoadingRows rows={6} /> : !snapshot ? (
        <Card padded><EmptyStatePanel title="No classifier snapshot yet"
          description={`The nightly job aggregates confirmed check-ins from the last ${swr.data.windowDays} days. Use Recompute now, or check back after the next run.`} /></Card>
      ) : (
        <>
          <Card padded>
            <div className="space-y-2 text-caption text-text-muted">
              <p>
                Check-ins confirmed {new Date(snapshot.windowStart).toLocaleDateString()} to {new Date(snapshot.generatedAt).toLocaleString()} (last {snapshot.windowDays} days).
                Every row below comes from at least {snapshot.kFloor} different players; {snapshot.totals.suppressedPairs} smaller {snapshot.totals.suppressedPairs === 1 ? "pair" : "pairs"} ({snapshot.totals.suppressedCheckIns} check-ins) {snapshot.totals.suppressedPairs === 1 ? "is" : "are"} withheld.
              </p>
              <p>Rules stay human-edited: nothing here changes a detector rule. Edit a rule in <Link href="/admin/build-studio" className="text-accent underline">Build Studio</Link>, then compare the next snapshot.</p>
              {snapshot.totals.truncated ? <p role="status" className="text-warning">This window had more check-ins than one run reads; only the newest are counted.</p> : null}
            </div>
          </Card>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricStat label="Check-ins" value={snapshot.totals.checkIns.toLocaleString()} caption="confirmed, in the window" />
            <MetricStat label="Disagreements" value={snapshot.totals.disagreements.toLocaleString()} caption="declared build was not detected" />
            <MetricStat label="Players" value={snapshot.totals.users.toLocaleString()} caption="who checked in" />
          </div>
          <EngineTrend engines={snapshot.engines} selected={view.engine} onSelect={(engine) => setView({ engine })} />
          <Provenance origins={snapshot.origins} />
          <Card padded>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Axis">
                <Select value={view.axis} onChange={(event) => setView({ axis: event.target.value })}>
                  <option value="all">Both axes</option>
                  <option value="build">{AXIS_LABEL.build}</option>
                  <option value="opponent">{AXIS_LABEL.opponent}</option>
                </Select>
              </Field>
              <Field label="Matchup">
                <Select value={view.matchup} onChange={(event) => setView({ matchup: event.target.value })}>
                  <option value="">All matchups</option>
                  {[...new Set([...snapshot.matchups, ...(view.matchup ? [view.matchup] : [])])].map((matchup) => <option key={matchup} value={matchup}>{matchup}</option>)}
                </Select>
              </Field>
              <Field label="Engine">
                <Select value={view.engine} onChange={(event) => setView({ engine: event.target.value })}>
                  <option value="">All engines</option>
                  {[...new Set([...snapshot.engines.map((row) => row.engine), ...(view.engine ? [view.engine] : [])])].map((engine) => <option key={engine} value={engine}>{engineLabel(engine)}</option>)}
                </Select>
              </Field>
            </div>
          </Card>
          <SegmentedControl label="Console view" value={view.tab as View} onChange={(tab) => setView({ tab })}
            options={[{ value: "pairs", label: "Pairs" }, { value: "confusion", label: "Confusion" }, { value: "labels", label: "Labels" }]} />
          {view.tab === "labels" ? <LabelsView data={swr.data} /> : view.tab === "confusion"
            ? <ConfusionView pairs={swr.data.pairs || []} onDrill={setDrill} />
            : <PairsView pairs={swr.data.pairs || []} total={swr.data.pairsTotal || 0} onDrill={setDrill} />}
        </>
      )}
      <Modal open={drill !== null} onClose={() => setDrill(null)} title="Disagreement samples" size="2xl" desktopLayout="side">
        {drill ? <ClassifierSamples pair={drill} /> : null}
      </Modal>
    </div>
  );
}

function pairName(pair: ClassifierPair) {
  return `${pair.detected} → ${pair.declared}`;
}

function PairsView({ pairs, total, onDrill }: { pairs: ClassifierPair[]; total: number; onDrill: (pair: ClassifierPair) => void }) {
  if (!pairs.length) return <Card padded><EmptyStatePanel title="No disagreements in this cohort" description="Try another axis, matchup or engine." /></Card>;
  return (
    <section aria-labelledby="classifier-pairs" className="space-y-2">
      <h2 id="classifier-pairs" className="text-h3">Detected → declared, by disagreement volume</h2>
      <p className="text-caption text-text-muted">{pairs.length < total ? `The ${pairs.length} largest of ${total} pairs.` : `${total} ${total === 1 ? "pair" : "pairs"}.`}</p>
      <Card padded={false}>
        <ol className="divide-y divide-border">
          {pairs.map((pair) => (
            <li key={`${pair.axis}|${pair.matchup}|${pairName(pair)}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words text-body"><span className="text-text-muted">Detected</span> {pair.detected} <span aria-hidden="true">→</span><span className="sr-only">, declared</span> <span className="font-semibold">{pair.declared}</span></p>
                <p className="text-caption text-text-muted">{pair.matchup} · {AXIS_LABEL[pair.axis]} · {pair.count} {pair.count === 1 ? "check-in" : "check-ins"} from {pair.users} players · {provenanceText(pair.origins)}</p>
                {pair.engines.length ? <p className="text-micro text-text-dim">{pair.engines.map((row) => `${engineLabel(row.engine)} ${row.count}`).join(" · ")}</p> : null}
              </div>
              <Button size="sm" variant="secondary" onClick={() => onDrill(pair)}>Samples<span className="sr-only"> for {pairName(pair)} in {pair.matchup}</span></Button>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

/** Each detected label with the builds players declared instead. */
function ConfusionView({ pairs, onDrill }: { pairs: ClassifierPair[]; onDrill: (pair: ClassifierPair) => void }) {
  const groups = new Map<string, ClassifierPair[]>();
  for (const pair of pairs) groups.set(`${pair.axis}|${pair.matchup}|${pair.detected}`, [...(groups.get(`${pair.axis}|${pair.matchup}|${pair.detected}`) || []), pair]);
  if (!groups.size) return <Card padded><EmptyStatePanel title="No disagreements in this cohort" description="Try another axis, matchup or engine." /></Card>;
  return (
    <section aria-labelledby="classifier-confusion" className="space-y-3">
      <h2 id="classifier-confusion" className="text-h3">Confusion: what each detected label should have been</h2>
      {[...groups.values()].map((rows) => {
        const head = rows[0];
        const sum = rows.reduce((total, row) => total + row.count, 0);
        return (
          <Card key={`${head.axis}|${head.matchup}|${head.detected}`} padded>
            <h3 className="break-words text-body font-semibold">{head.detected}</h3>
            <p className="text-caption text-text-muted">{head.matchup} · {AXIS_LABEL[head.axis]} · {sum} disagreeing check-ins</p>
            <ul className="mt-2 space-y-1">
              {rows.map((row) => (
                <li key={row.declared} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 break-words text-caption">declared <span className="font-semibold">{row.declared}</span></span>
                  <span className="text-caption tabular-nums text-text-muted">{row.count}</span>
                  <Button size="sm" variant="ghost" onClick={() => onDrill(row)}>Samples<span className="sr-only"> for {pairName(row)} in {row.matchup}</span></Button>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </section>
  );
}

function LabelsView({ data }: { data: ClassifierConsoleResp }) {
  const labels = data.labels || [];
  if (!labels.length) return <Card padded><EmptyStatePanel title="No labels meet the player floor yet" description={`A label appears once ${data.kFloor} players have checked in with it.`} /></Card>;
  return (
    <section aria-labelledby="classifier-labels" className="space-y-2">
      <h2 id="classifier-labels" className="text-h3">Labels: matches and disagreements</h2>
      <p className="text-caption text-text-muted">Missed: declared, but the detector said something else. Mislabeled: detected, but the player declared something else.</p>
      <Card padded={false}>
        <ul className="divide-y divide-border">
          {labels.map((row) => (
            <li key={`${row.axis}|${row.label}`} className="space-y-1 px-4 py-3">
              <p className="break-words text-body font-semibold">{row.label}</p>
              <p className="text-caption text-text-muted">{AXIS_LABEL[row.axis]} · matches {row.agree} · missed {row.missed} · mislabeled {row.mislabeled} · {row.users} players</p>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** Check-ins and disagreements per detecting engine, newest version first. */
function EngineTrend({ engines, selected, onSelect }: { engines: ClassifierEngine[]; selected: string; onSelect: (engine: string) => void }) {
  if (!engines.length) return null;
  const most = Math.max(1, ...engines.map((row) => row.disagreements));
  return (
    <section aria-labelledby="classifier-engines" className="space-y-2">
      <h2 id="classifier-engines" className="text-h3">By engine version</h2>
      <p className="text-caption text-text-muted">Recent snapshots show disagreement counts over the rolling window.</p>
      <Card padded={false}>
        <ul className="divide-y divide-border">
          {engines.map((row) => (
            <li key={row.engine} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 text-caption">{engineLabel(row.engine)}</span>
              <span className="text-caption tabular-nums text-text-muted">{row.disagreements} of {row.checkIns} check-ins disagree</span>
              <span aria-hidden="true" className="h-2 w-24 overflow-hidden rounded-full bg-bg-elevated"><span className="block h-full bg-warning" style={{ width: `${Math.round((row.disagreements / most) * 100)}%` }} /></span>
              <Button size="sm" variant={selected === row.engine ? "primary" : "ghost"} aria-pressed={selected === row.engine}
                onClick={() => onSelect(selected === row.engine ? "" : row.engine)}>Filter<span className="sr-only"> by {engineLabel(row.engine)}</span></Button>
              {row.trend && row.trend.length > 1 ? <ul aria-label={`${engineLabel(row.engine)} recent snapshots`} className="flex w-full flex-wrap gap-x-3 gap-y-1 text-micro text-text-dim">
                {row.trend.map((point) => <li key={point.generatedAt}>{new Date(point.generatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {point.disagreements.toLocaleString()}</li>)}
              </ul> : null}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Provenance({ origins }: { origins: ClassifierOrigins }) {
  return (
    <p className="text-caption text-text-muted">
      Where check-ins came from: {provenanceText(origins)}.
    </p>
  );
}

function provenanceText(origins: ClassifierOrigins) {
  return (Object.keys(ORIGIN_LABEL) as Array<keyof ClassifierOrigins>)
    .filter((key) => origins[key] > 0)
    .map((key) => `${ORIGIN_LABEL[key]} ${origins[key]}`)
    .join(", ") || "none";
}
