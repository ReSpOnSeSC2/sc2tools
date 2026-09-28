"use client";

/**
 * InstantReport — the /try report over games analysed on this device:
 * a header with totals (games, W-L, win rate), one card per report
 * section — record by matchup, macro, your openers next to your
 * opponents' openers, MMR, most-faced opponent and the loss autopsy of
 * your most recent loss — then "Game by game": a game picker with both
 * build orders and the macro timeline of the selected game.
 *
 * ALL DATA IS REAL: every card renders nothing when its section of the
 * report (`buildInstantReport`) is null, so a visitor only ever sees
 * insights their own replays support. Mobile-first: cards stack in one
 * column and wrap their text, so nothing scrolls sideways at 360 px.
 *
 * Example:
 *   const report = buildInstantReport(payloads, new Date());
 *   <InstantReport report={report} />
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { InstantReport as InstantReportData } from "@/lib/instant/report";
import { LastLossCard } from "./report/LastLossCard";
import { LazyGamesSection } from "./report/LazyGamesSection";
import { MacroCard } from "./report/MacroCard";
import { MmrCard } from "./report/MmrCard";
import { MostFacedCard } from "./report/MostFacedCard";
import { OpenersCard, OpponentOpenersCard } from "./report/OpenersCard";
import { RecordByMatchupCard } from "./report/RecordByMatchupCard";
import { WinLoss, gamesLabel, winratePercent } from "./report/ReportBits";

export interface InstantReportProps {
  report: InstantReportData;
  /** Actions shown next to the heading (e.g. "Analyze more replays"). */
  actions?: ReactNode;
  /**
   * Bump (> 0) after a finished analysis to move keyboard focus to the
   * report heading — the panel that had focus just went away. 0 (the
   * default, e.g. a revisit) never steals focus.
   */
  focusKey?: number;
  className?: string;
}

function TotalsLine({ report }: { report: InstantReportData }) {
  const { games, wins, losses } = report.totals;
  const rate = winratePercent(wins, losses);
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body text-text-muted">
      <span className="font-semibold text-text">{gamesLabel(games)}</span>
      <WinLoss wins={wins} losses={losses} />
      {rate !== null ? <span className="tabular-nums">{rate}% win rate</span> : null}
    </p>
  );
}

/**
 * Two cards side by side on wider screens; nothing (not even an empty
 * grid) when neither has data.
 */
function CardPair({ show, children }: { show: boolean; children: ReactNode }) {
  return show ? <div className="grid gap-4 md:grid-cols-2">{children}</div> : null;
}

/**
 * The instant report (see module comment). Renders nothing for an
 * empty report (no usable games).
 *
 * Example:
 *   <InstantReport report={report} actions={<Button>Analyze more replays</Button>} />
 */
export function InstantReport({ report, actions, focusKey = 0, className = "" }: InstantReportProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusKey > 0) heading.current?.focus();
  }, [focusKey]);
  if (report.totals.games === 0) return null;
  return (
    <section aria-labelledby={headingId} className={["space-y-4", className].filter(Boolean).join(" ")}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="font-display text-h2 text-text focus:outline-none">
            Your instant report
          </h2>
          <TotalsLine report={report} />
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      <CardPair show={report.recordByMatchup !== null || report.macro !== null}>
        <RecordByMatchupCard rows={report.recordByMatchup} />
        <MacroCard macro={report.macro} />
      </CardPair>
      <CardPair show={report.openers !== null || report.opponentOpeners !== null}>
        <OpenersCard rows={report.openers} />
        <OpponentOpenersCard rows={report.opponentOpeners} />
      </CardPair>
      <CardPair show={report.mmr !== null || report.mostFaced !== null}>
        <MmrCard rows={report.mmr} />
        <MostFacedCard opponent={report.mostFaced} />
      </CardPair>
      <LastLossCard lastLoss={report.lastLoss} />
      <LazyGamesSection games={report.games} />
    </section>
  );
}
