"use client";

import { Fragment, useMemo, useState } from "react";
import { battleReportFacts, type BattleReportInput, type ReportTone } from "@/lib/battleReport/facts";
import { planBattleReport } from "@/lib/battleReport/plan";
import { formatGameClock } from "@/lib/macro";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { ReportCopy } from "./ReportCopy";
import { ReportSentence } from "./ReportSentence";
import { BattleSnapshot } from "./BattleSnapshot";

const TONES: { value: ReportTone; label: string }[] = [{ value: "battle", label: "Battle report" }, { value: "caster", label: "Caster" }, { value: "tactical", label: "Tactical" }];

export function BattleReportSection({ input, onSeek, segmented = false, pending = false }: { input: BattleReportInput; onSeek: (time: number) => void; segmented?: boolean; pending?: boolean }) {
  const [tone, setTone] = useState<ReportTone>("battle");
  const { game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, playback, story } = input;
  const partialPlayback = segmented || playback?.fidelity?.complete === false;
  const completePlayback = partialPlayback ? null : playback;
  const facts = useMemo(() => battleReportFacts({ game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, playback: completePlayback, story }), [game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, completePlayback, story]);
  const report = useMemo(() => planBattleReport(facts, tone), [facts, tone]);
  const dateline = [facts.map, facts.date, facts.length === null ? null : formatGameClock(facts.length)].filter(Boolean).join(" · ");
  const moments = facts.moments.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const perParagraph = Math.max(1, Math.ceil(moments.length / report.paragraphs.length));
  return <section id="battle-report" aria-labelledby="battle-report-title" className="scroll-mt-[var(--game-section-offset,8rem)] overflow-hidden rounded-xl border border-border bg-bg-surface">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6"><h2 id="battle-report-title" className="font-display text-h3 font-bold">Battle report</h2><div role="group" aria-label="Report tone" className="flex max-w-full flex-wrap gap-1">{TONES.map((option) => <button key={option.value} type="button" aria-pressed={tone === option.value} onClick={() => setTone(option.value)} className={`min-h-11 rounded-lg border px-3 text-caption font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tone === option.value ? "border-accent bg-accent/10 text-accent" : "border-transparent text-text-muted hover:border-border hover:text-text"}`}>{option.label}</button>)}</div></div>
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-5 sm:px-6 sm:py-8">
      <header className="space-y-2"><p className="text-micro uppercase tracking-widest text-text-dim">From the replay record</p><h3 className="break-words font-display text-h2 font-bold leading-tight text-text">{report.headline}</h3>{dateline ? <p className="text-caption text-text-muted">{dateline}</p> : null}{pending ? <p role="status" className="text-caption text-text-muted">Loading recorded details for the report…</p> : null}</header>
      {report.paragraphs.map((paragraph, index) => <Fragment key={paragraph.id}><p data-report-paragraph className={`mx-auto max-w-[68ch] break-words font-serif text-lg leading-relaxed text-text ${index === 0 ? "first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-5xl first-letter:font-bold first-letter:leading-none" : ""}`}>{paragraph.sentences.map((sentence, sentenceIndex) => <Fragment key={sentence.factId}>{sentenceIndex ? " " : ""}<ReportSentence sentence={sentence} gameId={facts.gameId} onSeek={onSeek} /></Fragment>)}</p>
        {moments.slice(index * perParagraph, (index + 1) * perParagraph).length ? <div className="grid gap-4 sm:grid-cols-2">{moments.slice(index * perParagraph, (index + 1) * perParagraph).map((moment) => <BattleSnapshot key={moment.id} moment={moment} playback={completePlayback} breakdown={breakdown} duration={facts.length} segmented={partialPlayback} myRace={game.myRace} oppRace={game.opponent?.race} onSeek={onSeek} />)}</div> : null}</Fragment>)}
      <div className="space-y-3 border-t border-border pt-5"><ReportCopy key={`${facts.gameId}:${tone}`} report={report} pending={pending} /><p className="text-caption text-text-muted">Written from this replay&apos;s recorded data with fixed rules, never AI. Missing events stay out of the account. <LazyHelpLink slug="battle-reports">How this is written</LazyHelpLink></p></div>
    </div>
  </section>;
}
