"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { readSampleReport } from "@/lib/instant/sampleReport";
import { buildInstantReport } from "@/lib/instant/report";
import { trackInstantSampleView } from "@/lib/instant/analytics";
import { InstantReport } from "./InstantReport";

type Sample = NonNullable<ReturnType<typeof readSampleReport>>;

async function fetchSample(signal: AbortSignal): Promise<Sample> {
  const responses = await Promise.all([fetch("/try/sample-payloads.json", { signal }), fetch("/engine/current.json", { signal, cache: "no-store" })]);
  if (responses.some((response) => !response.ok)) throw new Error("Sample unavailable");
  const [data, pointer] = await Promise.all(responses.map((response) => response.json()));
  const prefix = `/engine/${INSTANT_ENGINE_VERSION}/`;
  const bundle = typeof pointer?.manifest === "string" && pointer.manifest.startsWith(prefix) ? pointer.manifest.slice(prefix.length).match(/^([0-9a-f]{16})\/manifest\.json$/)?.[1] : null;
  const sample = bundle && pointer.engineVersion === INSTANT_ENGINE_VERSION ? readSampleReport(data, bundle) : null;
  if (!sample) throw new Error("Sample updated; reload this page");
  return sample;
}

export function SampleReportPreview() {
  const [attempt, setAttempt] = useState(0);
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setSample(null); setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Sample timed out")); controller.abort(); }, 20_000); });
    void Promise.race([fetchSample(controller.signal), deadline]).then((data) => {
      if (current) { setSample(data); trackInstantSampleView(); }
    }).catch(() => { if (current) setError("The sample is unavailable or has changed. Retry, or analyze your own replays."); }).finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  const report = useMemo(() => sample ? buildInstantReport(sample.payloads, new Date(Math.max(...sample.payloads.map((game) => Date.parse(game.date))))) : null, [sample]);
  return <section aria-label="Sample replay report" className="space-y-4 rounded-xl border-2 border-line bg-bg-surface p-3 sm:p-5" data-testid="sample-report-frame">
    <header><h2 className="font-display text-h3">Sample replay report</h2><p className="text-caption text-text-muted">Real fixture replays, with player identities removed. These examples are separate games; nothing is saved to your browser history or account.</p></header>
    {error ? <div role="alert"><p>{error}</p><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Retry sample</Button></div> : !report ? <p role="status">Loading the example report…</p> : <><p className="text-caption text-text-muted">Engine {sample?.metadata.engineVersion} · fixed sample data, not your results</p><InstantReport report={report} title="Example results" /></>}
  </section>;
}
