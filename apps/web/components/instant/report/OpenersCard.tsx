"use client";

/**
 * Openers — two cards with the same shape, side by side in the report:
 *
 *   OpenersCard         — W-L per build the classifier detected for you
 *                         (`report.openers`)
 *   OpponentOpenersCard — your W-L against each strategy the classifier
 *                         detected for your opponents
 *                         (`report.opponentOpeners`)
 *
 * Each shows the most played few and says how many more exist, and
 * renders nothing when its section is null.
 *
 * Example:
 *   <OpenersCard rows={report.openers} />
 *   <OpponentOpenersCard rows={report.opponentOpeners} />
 */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import type { OpenerRow } from "@/lib/instant/report";
import { ReportCard, WinLoss, WinrateText, WinrateBar, gamesLabel } from "./ReportBits";
import type { ReportGame } from "@/lib/instant/report";
import type { TryGuideProps } from "@/lib/instant/reportGuideTypes";
import { openerGuideLinks } from "@/lib/instant/reportOpenerLinks";

/** Openers listed before the "+N more" note. */
export const OPENERS_SHOWN = 5;

export interface OpenersCardProps extends TryGuideProps {
  rows: OpenerRow[] | null;
  games?: ReportGame[];
  focusEpoch?: number;
}

interface OpenerListCardProps extends OpenersCardProps {
  title: string;
  subtitle: string;
  testId: string;
  kind: "build" | "counter";
}

/** The shared list: name, games, W-L and win rate per row. */
function OpenerListCard({ rows, title, subtitle, testId, kind, games = [], guideLinks = [], guideFocus, focusEpoch = 0 }: OpenerListCardProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const focused = useRef<string | null>(null);
  const focusName = kind === "build" && guideFocus && games.some((game) => game.matchup === guideFocus.matchup && game.payload.myBuild === guideFocus.name) ? guideFocus.name : null;
  useEffect(() => {
    const intent = guideFocus ? `${guideFocus.key}:${focusEpoch}` : null;
    if (!focusName || !guideFocus || focused.current === intent) return;
    const target = list.current?.querySelector<HTMLElement>('[data-guide-focus="true"]');
    if (!target) return;
    focused.current = intent;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focusName, guideFocus, focusEpoch]);
  if (!rows || rows.length === 0) return null;
  const focusedIndex = rows.findIndex((row) => row.name === focusName);
  const shown = expanded ? rows : rows.slice(0, Math.max(OPENERS_SHOWN, focusedIndex + 1));
  return (
    <ReportCard title={title} subtitle={subtitle} testId={testId}>
      <ul ref={list} id={listId} className="divide-y divide-border">
        {shown.map((row) => { const links = openerGuideLinks(row.name, kind, games, guideLinks); return (
          <li key={row.name} tabIndex={row.name === focusName ? -1 : undefined} data-guide-focus={row.name === focusName ? "true" : undefined} className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0 ${row.name === focusName ? "rounded-md bg-accent/10 p-2 ring-2 ring-accent" : ""}`}>
            <span className="min-w-0 break-words font-semibold text-text">{links.length === 1 ? <Link href={links[0].href} className="inline-flex min-h-11 items-center text-accent underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-accent">{row.name}</Link> : row.name}</span>
            {links.length > 1 ? <span className="flex flex-wrap gap-3 text-caption">{links.map((link) => <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{link.matchup} guide</Link>)}</span> : null}
            <span className="flex items-baseline gap-3 text-caption">
              <span className="text-text-muted">{gamesLabel(row.games)}</span>
              <WinLoss wins={row.wins} losses={row.losses} />
              <WinrateText wins={row.wins} losses={row.losses} />
            </span>
            {row.wins + row.losses > 0 ? <WinrateBar wins={row.wins} losses={row.losses} /> : null}
          </li>
        ); })}
      </ul>
      {rows.length > OPENERS_SHOWN ? (
        <Button variant="ghost" className="mt-3 min-h-11" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${rows.length} openers`}
        </Button>
      ) : null}
    </ReportCard>
  );
}

/**
 * Most-played openers of yours with their records.
 *
 * Example:
 *   <OpenersCard rows={[{ name: "PvZ - Adept Glaives (Robo)", games: 3, wins: 2, losses: 1, winrate: 0.67 }]} />
 */
export function OpenersCard(props: OpenersCardProps) {
  return (
    <OpenerListCard
      {...props}
      kind="build"
      title="Your openers"
      subtitle="The builds we detected for you, and how they went."
      testId="report-openers"
    />
  );
}

/**
 * What your opponents opened with, most faced first, and your record
 * against each.
 *
 * Example:
 *   <OpponentOpenersCard rows={[{ name: "ZvP - Speedling Flood", games: 2, wins: 1, losses: 1, winrate: 0.5 }]} />
 */
export function OpponentOpenersCard(props: OpenersCardProps) {
  return (
    <OpenerListCard
      {...props}
      kind="counter"
      title="Opponent openers"
      subtitle="What your opponents opened with, and how you did against it."
      testId="report-opp-openers"
    />
  );
}
