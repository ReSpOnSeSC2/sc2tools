"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ImageDown } from "lucide-react";
import { battleReportFacts, type BattleReportInput, type ReportTone } from "@/lib/battleReport/facts";
import { planBattleReport } from "@/lib/battleReport/plan";
import type { MapPlayback } from "@/lib/mapReplay";
import { formatGameClock } from "@/lib/macro";
import { shareSafeReportInput } from "@/lib/sharedGame";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Button } from "@/components/ui/Button";
import { ReportCopy } from "./ReportCopy";
import { ReportSentence } from "./ReportSentence";
import { BattleSnapshot } from "./BattleSnapshot";

const TONES: { value: ReportTone; label: string }[] = [{ value: "battle", label: "Battle report" }, { value: "caster", label: "Caster" }, { value: "tactical", label: "Tactical" }];

/**
 * The battle report: headline, one to four paragraphs, captioned snapshots,
 * copy and "Save as image". The owner's game page and the public share page
 * both render it; ``timeHref`` points time links at the page showing it, and
 * ``actions`` adds the owner's share controls. The image is always drawn from
 * the share-safe report (players by race, no ratings), whoever saves it.
 */
export function BattleReportSection({ input, onSeek, segmented = false, pending = false, timeHref, actions, snapshotPlayback, loadSnapshotFrames }: {
  input: BattleReportInput; onSeek: (time: number) => void; segmented?: boolean; pending?: boolean;
  /** Where a time link points when opened in a new tab (default: the owner's game page). */
  timeHref?: (time: number) => string;
  actions?: ReactNode;
  snapshotPlayback?: MapPlayback | null;
  loadSnapshotFrames?: (times: number[]) => Promise<ReadonlyMap<number, MapPlayback>>;
}) {
  const [tone, setTone] = useState<ReportTone>("battle");
  const [saving, setSaving] = useState(false);
  const [imageError, setImageError] = useState("");
  const { game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, playback, story, voice } = input;
  const partialPlayback = segmented || playback?.fidelity?.complete === false;
  const completePlayback = partialPlayback ? null : playback;
  const facts = useMemo(() => battleReportFacts({ game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, playback: completePlayback, story, voice }), [game, myName, plannedBuild, buildEvents, oppBuildEvents, breakdown, completePlayback, story, voice]);
  const report = useMemo(() => planBattleReport(facts, tone), [facts, tone]);
  const dateline = [facts.map, facts.date, facts.length === null ? null : formatGameClock(facts.length)].filter(Boolean).join(" · ");
  const moments = facts.moments.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const perParagraph = Math.max(1, Math.ceil(moments.length / report.paragraphs.length));
  const meLabel = voice === "shared" ? "Player" : "You";
  const saveImage = async () => {
    setSaving(true); setImageError("");
    try {
      const image = await import("@/lib/battleReportImage");
      const safe = shareSafeReportInput({ ...input, playback: completePlayback });
      const shared = planBattleReport(battleReportFacts(safe), tone);
      const frames = await loadSnapshotFrames?.(image.reportImageMoments(shared).map((moment) => moment.time));
      const blob = await image.renderBattleReportPng(shared, {
        mine: breakdown?.stats_events, opponent: breakdown?.opp_stats_events, result: game.result, frames, playback: snapshotPlayback ?? completePlayback,
        myRace: game.myRace, oppRace: game.opponent?.race,
      });
      if (!blob) throw new Error("no canvas");
      image.downloadBlob(blob, image.battleReportImageFilename(shared));
    } catch {
      setImageError("Couldn't make the image. Please try again.");
    } finally {
      setSaving(false);
    }
  };
  return <section id="battle-report" aria-labelledby="battle-report-title" className="scroll-mt-[var(--game-section-offset,8rem)] overflow-hidden rounded-xl border border-border bg-bg-surface">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6"><h2 id="battle-report-title" className="font-display text-h3 font-bold">Battle report</h2><div role="group" aria-label="Report tone" className="flex max-w-full flex-wrap gap-1">{TONES.map((option) => <button key={option.value} type="button" aria-pressed={tone === option.value} onClick={() => setTone(option.value)} className={`min-h-11 rounded-lg border px-3 text-caption font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tone === option.value ? "border-accent bg-accent/10 text-accent" : "border-transparent text-text-muted hover:border-border hover:text-text"}`}>{option.label}</button>)}</div></div>
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-5 sm:px-6 sm:py-8">
      <header className="space-y-2"><p className="text-micro uppercase tracking-widest text-text-dim">From the replay record</p><h3 className="break-words font-display text-h2 font-bold leading-tight text-text">{report.headline}</h3>{dateline ? <p className="text-caption text-text-muted">{dateline}</p> : null}{pending ? <p role="status" className="text-caption text-text-muted">Loading recorded details for the report…</p> : null}</header>
      {report.paragraphs.map((paragraph, index) => <Fragment key={paragraph.id}><p data-report-paragraph className={`mx-auto max-w-[68ch] break-words font-serif text-lg leading-relaxed text-text ${index === 0 ? "first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-5xl first-letter:font-bold first-letter:leading-none" : ""}`}>{paragraph.sentences.map((sentence, sentenceIndex) => <Fragment key={sentence.factId}>{sentenceIndex ? " " : ""}<ReportSentence sentence={sentence} gameId={facts.gameId} onSeek={onSeek} href={timeHref} /></Fragment>)}</p>
        {moments.slice(index * perParagraph, (index + 1) * perParagraph).length ? <div className="grid gap-4 sm:grid-cols-2">{moments.slice(index * perParagraph, (index + 1) * perParagraph).map((moment) => <BattleSnapshot key={moment.id} moment={moment} playback={snapshotPlayback ?? completePlayback} breakdown={breakdown} duration={facts.length} segmented={partialPlayback} myRace={game.myRace} oppRace={game.opponent?.race} onSeek={onSeek} meLabel={meLabel} />)}</div> : null}</Fragment>)}
      <div className="space-y-3 border-t border-border pt-5">
        <div className="flex flex-wrap items-start gap-2">
          <ReportCopy key={`${facts.gameId}:${tone}`} report={report} pending={pending} linkFor={timeHref} />
          <Button variant="ghost" size="sm" loading={saving} disabled={pending} iconLeft={<ImageDown className="h-4 w-4" aria-hidden />} onClick={() => void saveImage()}>Save as image</Button>
          {actions}
        </div>
        {imageError ? <p role="status" className="text-caption text-danger">{imageError}</p> : null}
        <p className="text-caption text-text-muted">Written from this replay&apos;s recorded data with fixed rules, never AI. Missing events stay out of the account. The image names no one: players appear by race. <LazyHelpLink slug="battle-reports">How this is written</LazyHelpLink></p>
      </div>
    </div>
  </section>;
}
