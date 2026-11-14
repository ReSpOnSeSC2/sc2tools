"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Scale } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { cohortOptions, getBalanceCohort, loadBalanceEvidence, type BalanceEvidence } from "@/lib/balance/evidence";
import { decideReplayVerdict, replayCases, replayCohort, replayExhibits, replayMap } from "@/lib/balance/replayVerdict";
import type { InstantPayload } from "@/lib/instant/reportPayload";
import { BalanceVerdictCredit, ReplayVerdictCard } from "./ReplayVerdictCard";

type CourtCase = ReturnType<typeof replayCases>[number];
const FORMAT = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function LocalExhibits({ exhibits }: { exhibits: ReturnType<typeof replayExhibits> }) {
  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg-elevated p-4">
      <h3 className="text-body font-semibold text-text">Replay exhibits</h3>
      {exhibits.own.length ? (
        <ul className="list-disc space-y-1 pl-5 text-body text-text-muted">
          {exhibits.own.map(cause => <li key={cause.id}>{cause.detail}</li>)}
        </ul>
      ) : <p className="text-body text-text-muted">{exhibits.severity === null ? "This replay has too little macro data for an autopsy." : "The autopsy did not flag a major mistake."}</p>}
      {exhibits.mirrors.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-body font-semibold text-text">Mirror test</h4>
          <ul className="list-disc space-y-1 pl-5 text-caption text-text-muted">
            {exhibits.mirrors.map(({ cause, opponentSeverity }) => (
              <li key={cause.id}>{cause.title} · severity out of 100 · you {cause.severityScore}, opponent {opponentSeverity}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {exhibits.earlyAggression ? <p className="text-body text-text-muted">The replay detector identified an early rush or proxy.</p> : null}
      <p className="text-caption text-text-muted">Only the verdict and the ladder cohort appear in the shared card.</p>
    </div>
  );
}

function CaseEvidence({ selected, evidence }: { selected: CourtCase; evidence: BalanceEvidence }) {
  const id = useId();
  const [cohortOverride, setCohort] = useState<string | null>(null);
  const [useMap, setUseMap] = useState(false);
  const { game, race, opponent } = selected;
  const estimate = replayCohort(evidence, game);
  const cohort = cohortOverride ?? estimate?.key ?? "";
  const map = replayMap(evidence, game.map);
  const mapHasData = map && !!getBalanceCohort(evidence, cohort, race, opponent, map.id);
  const mapId = useMap && mapHasData ? map.id : undefined;
  const counts = cohort ? getBalanceCohort(evidence, cohort, race, opponent, mapId) : null;
  const exhibits = replayExhibits(game);
  return (
    <div className="space-y-4">
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-cohort`} className="block text-body font-semibold text-text">Ladder cohort</label>
          <Select value={cohort} onChange={event => setCohort(event.target.value)} id={`${id}-cohort`}>
            <option value="">Choose a league or tier</option>
            {cohortOptions(evidence).map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
          </Select>
        </div>
        {mapHasData ? (
          <label className="flex min-h-11 items-center gap-2 text-body text-text">
            <input type="checkbox" className="size-5 accent-accent" checked={useMap} onChange={event => setUseMap(event.target.checked)} />
            Use {map.name} only
          </label>
        ) : null}
      </div>
      {cohortOverride === null && estimate ? <p className="text-caption text-text-muted">{estimate.source === "mmr" ? "Tier estimated from your replay rating and regional ladder bounds." : "League estimated from the opponent’s league in the replay."}</p> : null}
      <p className="text-caption text-text-muted">The benchmark uses the latest available ladder snapshot. Your replay may be from a different season or patch.</p>
      {!cohort ? <p className="text-body text-text-muted">Choose a league or tier to compare this loss with ladder games.</p> : null}
      {cohort && !counts ? <p role="status" className="text-body text-text-muted">This cohort has no same-tier games for the matchup. Choose a broader league.</p> : null}
      {counts ? <ReplayVerdictCard evidence={evidence} summary={{
        season: evidence.season, asOf: evidence.asOf, race, opponent, cohort,
        verdict: decideReplayVerdict(counts.interval, exhibits), mapId,
      }} /> : null}
      <LocalExhibits exhibits={exhibits} />
    </div>
  );
}

export function ReplayBalanceCourt({ payloads, intakeVisible, onAdd }: {
  payloads: readonly InstantPayload[];
  intakeVisible: boolean;
  onAdd: () => void;
}) {
  const id = useId();
  const cases = replayCases(payloads);
  const [selection, setSelection] = useState("");
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "unavailable" | BalanceEvidence>("loading");
  const selected = cases.find(option => option.game.gameId === selection) ?? cases[0];
  const isReviewing = open && !!selected;
  useEffect(() => {
    if (!isReviewing) return;
    const controller = new AbortController();
    loadBalanceEvidence(undefined, controller.signal).then(evidence => {
      if (!controller.signal.aborted) setState(evidence ?? "unavailable");
    }).catch(() => {
      if (!controller.signal.aborted) setState("unavailable");
    });
    return () => controller.abort();
  }, [isReviewing, attempt]);
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4 rounded-xl border border-line bg-bg-surface p-4 sm:p-6">
      <div className="space-y-2">
        <h2 id={`${id}-heading`} className="flex items-center gap-2 font-display text-h2 text-text"><Scale size={22} aria-hidden />Balance Court</h2>
        <p className="text-body text-text-muted">Compare a ranked 1v1 loss with same-tier ladder games. Your replay stays in this browser.</p>
        <BalanceVerdictCredit />
      </div>
      {!selected ? (
        <div className="flex flex-wrap items-center gap-3">
          {intakeVisible ? <Link href="#try-replay-intake" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">Add a ranked 1v1 loss</Link> : <Button variant="secondary" onClick={onAdd}>Add a ranked 1v1 loss</Button>}
          <Link href="/balance" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">Browse ladder balance</Link>
        </div>
      ) : !open ? <Button variant="secondary" onClick={() => setOpen(true)}>Review a loss</Button> : (
        <>
          {cases.length > 1 ? (
            <div className="max-w-sm space-y-1">
              <label htmlFor={`${id}-loss`} className="block text-body font-semibold text-text">Ranked loss</label>
              <Select id={`${id}-loss`} value={selected.game.gameId} onChange={event => setSelection(event.target.value)}>
                {cases.map(({ game, race, opponent }) => {
                  const date = new Date(game.date);
                  return <option key={game.gameId} value={game.gameId}>{race}v{opponent}{game.map ? ` · ${game.map}` : ""}{Number.isFinite(date.valueOf()) ? ` · ${FORMAT.format(date)}` : ""}</option>;
                })}
              </Select>
            </div>
          ) : null}
          {state === "loading" ? <p role="status" className="text-body text-text-muted">Loading ladder evidence…</p> : null}
          {state === "unavailable" ? <div className="space-y-2"><p role="status" className="text-body text-text-muted">Ladder evidence is temporarily unavailable.</p><Button variant="secondary" onClick={() => { setState("loading"); setAttempt(previous => previous + 1); }}>Try again</Button></div> : null}
          {typeof state === "object" ? <CaseEvidence key={selected.game.gameId} selected={selected} evidence={state} /> : null}
        </>
      )}
    </section>
  );
}
