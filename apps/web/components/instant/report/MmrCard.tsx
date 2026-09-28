/**
 * MMR — per account and race queue, your pre-game MMR in the first and
 * the latest ladder game of these replays, the net change between them
 * and the peak, from `report.mmr` (the season recap's MMR journey, run
 * per queue). Replays only record MMR at the start of a game, so every
 * number is a pre-game value and the card says so. Renders nothing when
 * the section is null (no queue has two ladder games with an MMR).
 *
 * Example:
 *   <MmrCard rows={report.mmr} />
 */
import type { MmrQueueRow } from "@/lib/instant/report";
import { formatMmr, signedMmr } from "@/lib/instant/reportMmr";
import { ReportCard, gamesLabel } from "./ReportBits";

export interface MmrCardProps {
  rows: MmrQueueRow[] | null;
}

function deltaTone(delta: number): string {
  if (delta > 0) return "text-success";
  return delta < 0 ? "text-danger" : "text-text-muted";
}

function QueueRow({ row }: { row: MmrQueueRow }) {
  return (
    <li className="space-y-1 py-2 first:pt-0 last:pb-0">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-caption">
        <span className="min-w-0 break-words font-semibold text-text">
          {row.accountLabel} · {row.race} queue
        </span>
        <span className="text-text-muted">{gamesLabel(row.games)}</span>
      </p>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-display text-h4 tabular-nums text-text">
          {formatMmr(row.start)} <span aria-hidden>→</span>
          <span className="sr-only">to</span> {formatMmr(row.end)}
        </span>
        <span className={["font-semibold tabular-nums", deltaTone(row.delta)].join(" ")}>{signedMmr(row.delta)}</span>
        <span className="text-caption text-text-muted tabular-nums">peak {formatMmr(row.peak)}</span>
      </p>
    </li>
  );
}

/**
 * First → latest pre-game MMR, net change and peak per queue.
 *
 * Example:
 *   <MmrCard rows={[{ accountLabel: "NA 267727", race: "Protoss", games: 3, start: 5326, end: 5390, peak: 5402, delta: 64, ... }]} />
 */
export function MmrCard({ rows }: MmrCardProps) {
  if (!rows || rows.length === 0) return null;
  return (
    <ReportCard
      title="MMR"
      subtitle="Your pre-game MMR in these ladder replays, from the first game to the latest, per account and queue."
      testId="report-mmr"
    >
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <QueueRow key={`${row.toonHandle}|${row.race}`} row={row} />
        ))}
      </ul>
      <p className="pt-3 text-caption text-text-muted">
        Replays record MMR at the start of each game, so the result of your latest game is not included.
      </p>
    </ReportCard>
  );
}
