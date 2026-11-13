"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar } from "@/components/ui/Skeleton";
import { submitCrowdBallot, type CrowdResult, type DailyBallot } from "@/lib/daily/crowd";
import { dailyFightLink } from "@/lib/daily/fightLink";
import { CALLS } from "@/lib/daily/rules";

type CrowdState = { state: "idle" | "loading" | "error" | "unavailable" } | CrowdResult;
const NUMBER = new Intl.NumberFormat("en");
const PERCENT = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });

export function DailyCrowd({ ballot }: { ballot: DailyBallot }) {
  const [result, setResult] = useState<CrowdState>({ state: "idle" });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, []);
  async function submit() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 8_000);
    setResult({ state: "loading" });
    try {
      const split = await submitCrowdBallot(ballot, controller.signal);
      if (active.current === controller) setResult(split ?? { state: "unavailable" });
    } catch {
      // An unmount abort has no visible caller. A deadline does.
      if (active.current === controller) setResult({ state: "error" });
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
    }
  }
  return (
    <section className="min-h-40 space-y-3 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" aria-label="Crowd split">
      <h2 className="font-display text-heading font-bold text-text">Crowd split</h2>
      <p className="text-body text-text-muted">Send your five calls anonymously to see how the crowd called each fight.</p>
      {result.state === "ready" ? <CrowdFights day={ballot.day} result={result} /> :
        <CrowdAction state={result.state} onSubmit={() => void submit()} />}
    </section>
  );
}

function CrowdAction({ state, onSubmit }: { state: Exclude<CrowdState["state"], "ready">; onSubmit: () => void }) {
  return <>
    {state === "error" && <p role="alert" className="text-caption text-text-muted">The split did not load. You can retry without adding another vote.</p>}
    {state === "waiting" && <p role="status" className="text-caption text-text-muted">You're one of the first. The split appears after 20 votes.</p>}
    {state === "unavailable" && <p role="status" className="text-caption text-text-muted">Crowd voting is closed for this set.</p>}
    {state === "loading" && <div role="status" aria-label="Loading crowd split"><SkeletonBar className="h-5 w-40" /></div>}
    {state !== "unavailable" && <Button className="min-h-11" aria-disabled={state === "loading"} onClick={onSubmit}>
      {state === "error" ? "Retry crowd split" : state === "waiting" ? "Check crowd split" : "See crowd split"}
    </Button>}
  </>;
}

function CrowdFights({ day, result }: { day: number; result: Extract<CrowdResult, { state: "ready" }> }) {
  const summary = useRef<HTMLParagraphElement>(null);
  useEffect(() => summary.current?.focus(), []);
  return <>
    <p ref={summary} role="status" tabIndex={-1} className="text-caption text-text-muted focus-visible:ring-2 focus-visible:ring-accent">
      {NUMBER.format(result.total)} votes for this set.
    </p>
    <ol className="grid gap-3 sm:grid-cols-2">
      {result.fights.map((counts, slot) => (
        <li key={slot} className="space-y-2 rounded-lg border border-line p-3">
          <a href={dailyFightLink(day, slot)} className="inline-flex min-h-11 items-center rounded font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
            Play fight {slot + 1}
          </a>
          <dl className="space-y-1 text-caption text-text">
            {counts.map((count, call) => (
              <CrowdShare key={CALLS[call]} label={CALLS[call]} share={count / result.total} />
            ))}
          </dl>
        </li>
      ))}
    </ol>
  </>;
}

function CrowdShare({ label, share }: { label: string; share: number }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_3.25rem] items-baseline gap-x-2">
    <dt>
      {label}
      <span aria-hidden="true" className="mt-1 block h-1 overflow-hidden rounded-full bg-bg-elevated">
        <span className="block h-full rounded-full bg-accent" style={{ width: (share * 100) + "%" }} />
      </span>
    </dt>
    <dd className="text-right tabular-nums">{PERCENT.format(share)}</dd>
  </div>;
}
