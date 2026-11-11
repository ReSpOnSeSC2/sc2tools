"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { useToastOptional } from "@/components/ui/Toast";
import { useApi } from "@/lib/clientApi";
import { useCopy } from "@/lib/useCopy";
import { LoadingRows } from "../components/AdminFragments";
import { AXIS_LABEL, ORIGIN_LABEL, engineLabel, sampleFixture, type ClassifierPair, type ClassifierRule, type ClassifierSample, type ClassifierSamplesResp } from "./classifierTypes";

/**
 * The drill-down for one disagreement pair: the declared rule's
 * requirements (and the detected one's) beside up to 20 recent games, each
 * showing its build log up to 6:00. "Copy as test fixture" copies that
 * game's identity-free build log JSON for a replay-engine test.
 */
export function ClassifierSamples({ pair }: { pair: ClassifierPair }) {
  const params = new URLSearchParams({ axis: pair.axis, matchup: pair.matchup, detected: pair.detected, declared: pair.declared });
  const swr = useApi<ClassifierSamplesResp>(`/v1/admin/classifier/samples?${params}`, { revalidateOnFocus: false });
  return (
    <div className="space-y-4">
      <p className="break-words text-body">{pair.matchup} · {AXIS_LABEL[pair.axis]}: detected <strong>{pair.detected}</strong>, declared <strong>{pair.declared}</strong> ({pair.count} check-ins, {pair.users} players).</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <RuleCard heading="Declared rule" rule={swr.data?.rules.declared} name={pair.declared} />
        <RuleCard heading="Detected rule" rule={swr.data?.rules.detected} name={pair.detected} />
      </div>
      {swr.error ? <RequestError error={swr.error} onRetry={() => void swr.mutate()} /> : !swr.data ? <LoadingRows rows={4} /> : !swr.data.samples.length ? (
        <EmptyStatePanel title="No sample games found" description="The pair's check-ins may have been deleted or moved out of the window since the snapshot. Recompute to refresh it." />
      ) : (
        <section aria-labelledby="classifier-samples" className="space-y-3">
          <h3 id="classifier-samples" className="text-h3">Sample games ({swr.data.samples.length} of up to {swr.data.sampleLimit})</h3>
          <ol className="space-y-3">
            {swr.data.samples.map((sample) => <li key={sample.sample}><SampleCard pair={swr.data!.pair} sample={sample} sampleSeconds={swr.data!.sampleSeconds} /></li>)}
          </ol>
        </section>
      )}
    </div>
  );
}

function RuleCard({ heading, rule, name }: { heading: string; rule: ClassifierRule | undefined; name: string }) {
  return (
    <Card padded>
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">{heading}</h3>
      <p className="mt-1 break-words font-semibold">{name}</p>
      {rule === undefined ? null : rule === null ? (
        <p className="mt-1 text-caption text-text-muted">No released rule: a custom build (its owner&apos;s private rules), or a label outside the preset catalog.</p>
      ) : (
        <>
          <p className="mt-1 text-caption text-text-muted">{rule.description}</p>
          {rule.policy ? (
            <p className="mt-1 text-caption text-text-muted">Build Studio revision {rule.policy.revision}: {rule.policy.enabled ? `${rule.policy.mode === "released" ? "released rule" : "edited rule"} with ${rule.policy.anyOf.length} alternative ${rule.policy.anyOf.length === 1 ? "condition set" : "condition sets"}` : "disabled"}{rule.policy.steps.length ? `, ${rule.policy.steps.length} listed steps` : ""}.</p>
          ) : <p className="mt-1 text-micro text-text-dim">Released engine rule; no Build Studio edit.</p>}
        </>
      )}
    </Card>
  );
}

function SampleCard({ pair, sample, sampleSeconds }: { pair: ClassifierPair; sample: ClassifierSample; sampleSeconds: number }) {
  const toast = useToastOptional();
  const clipboard = useCopy({
    scopeKey: `${pair.axis}|${pair.matchup}|${pair.detected}|${pair.declared}|${sample.sample}`,
    onCopied: () => toast?.toast.success("Test fixture copied"),
  });
  const setInput = useCallback((node: HTMLInputElement | null) => { clipboard.inputRef.current = node; }, [clipboard.inputRef]);
  const fixture = JSON.stringify(sampleFixture(pair, sample, sampleSeconds), null, 2);
  return (
    <Card padded>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-body font-semibold">Sample {sample.sample}</h4>
        <Button size="sm" variant="secondary" disabled={!sample.buildLogAvailable || clipboard.pending} onClick={() => { void clipboard.copy(fixture); }}>
          {clipboard.copied ? "Copied" : "Copy as test fixture"}<span className="sr-only"> for sample {sample.sample}</span>
        </Button>
      </div>
      <p className="text-caption text-text-muted">{[sample.day, sample.map, sample.durationSec ? `${Math.floor(sample.durationSec / 60)}:${String(sample.durationSec % 60).padStart(2, "0")}` : null,
        engineLabel(sample.engine), ORIGIN_LABEL[sample.origin as keyof typeof ORIGIN_LABEL] || sample.origin].filter(Boolean).join(" · ")}</p>
      <span role="status" className="sr-only">{clipboard.copied ? "Test fixture copied" : ""}</span>
      {clipboard.fallbackText !== null ? (
        <div className="mt-2 space-y-1">
          <label htmlFor={`fixture-${sample.sample}`} className="block text-caption font-semibold">Copy the fixture manually</label>
          <Input ref={setInput} id={`fixture-${sample.sample}`} readOnly value={clipboard.fallbackText} onFocus={(event) => event.currentTarget.select()} className="min-h-11 font-mono" />
          <Button size="sm" variant="ghost" onClick={clipboard.clear}>Done</Button>
        </div>
      ) : null}
      {sample.buildLogAvailable ? (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named build-log region must accept keyboard scrolling.
        <pre aria-label={`Build log up to ${Math.floor(sampleSeconds / 60)}:00 for sample ${sample.sample}`} tabIndex={0}
          className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-bg-elevated/40 p-3 font-mono text-micro text-text-muted">
          {sample.buildLog.join("\n")}{sample.buildLogTruncated ? "\n…" : ""}
        </pre>
      ) : <p className="mt-2 text-caption text-text-muted">Build log unavailable for this game.</p>}
    </Card>
  );
}
