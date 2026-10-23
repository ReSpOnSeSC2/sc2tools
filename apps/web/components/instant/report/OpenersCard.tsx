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
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { OpenerRow } from "@/lib/instant/report";
import { ReportCard, WinLoss, WinrateText, WinrateBar, gamesLabel } from "./ReportBits";

/** Openers listed before the "+N more" note. */
export const OPENERS_SHOWN = 5;

export interface OpenersCardProps {
  rows: OpenerRow[] | null;
}

interface OpenerListCardProps extends OpenersCardProps {
  title: string;
  subtitle: string;
  testId: string;
}

/** The shared list: name, games, W-L and win rate per row. */
function OpenerListCard({ rows, title, subtitle, testId }: OpenerListCardProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!rows || rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, OPENERS_SHOWN);
  return (
    <ReportCard title={title} subtitle={subtitle} testId={testId}>
      <ul id={listId} className="divide-y divide-border">
        {shown.map((row) => (
          <li key={row.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
            <span className="min-w-0 break-words font-semibold text-text">{row.name}</span>
            <span className="flex items-baseline gap-3 text-caption">
              <span className="text-text-muted">{gamesLabel(row.games)}</span>
              <WinLoss wins={row.wins} losses={row.losses} />
              <WinrateText wins={row.wins} losses={row.losses} />
            </span>
            {row.wins + row.losses > 0 ? <WinrateBar wins={row.wins} losses={row.losses} /> : null}
          </li>
        ))}
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
export function OpenersCard({ rows }: OpenersCardProps) {
  return (
    <OpenerListCard
      rows={rows}
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
export function OpponentOpenersCard({ rows }: OpenersCardProps) {
  return (
    <OpenerListCard
      rows={rows}
      title="Opponent openers"
      subtitle="What your opponents opened with, and how you did against it."
      testId="report-opp-openers"
    />
  );
}
