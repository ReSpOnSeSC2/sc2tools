/**
 * Small presentational pieces shared by the /try instant-report cards:
 * the card frame (title + optional subtitle), a W-L pair, a win-rate
 * label, a thin win-rate bar, a one-game W/L mark and the report's date
 * format. Pure and prop-driven; no data fetching.
 *
 * Example:
 *   <ReportCard title="Record by matchup" testId="report-matchups">
 *     <WinLoss wins={3} losses={1} />
 *   </ReportCard>
 */
import type { ReactNode } from "react";
import { PERCENT } from "@/lib/instant/displayUnits";

/**
 * Win rate over decided games as a whole percentage, or null when no
 * game was decided (ties only) — callers then show "—", never "0%".
 *
 * Example:
 *   winratePercent(3, 1); // -> 75
 *   winratePercent(0, 0); // -> null
 */
export function winratePercent(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided > 0 ? Math.round((wins / decided) * PERCENT) : null;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

/**
 * A game date as "May 8, 2026" (local time); null when unparseable.
 *
 * Example:
 *   formatReportDate("2026-05-08T19:08:12Z"); // -> "May 8, 2026"
 */
export function formatReportDate(iso: string): string | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString("en-US", DATE_FORMAT) : null;
}

/**
 * "1 game" / "3 games".
 *
 * Example:
 *   gamesLabel(1); // -> "1 game"
 */
export function gamesLabel(count: number): string {
  return `${count} ${count === 1 ? "game" : "games"}`;
}

export interface ReportCardProps {
  title: string;
  subtitle?: ReactNode;
  /** `data-testid` for tests and e2e. */
  testId: string;
  children: ReactNode;
  className?: string;
}

/**
 * Frame for one report card (same surface as `Card`, with a real h3).
 *
 * Example:
 *   <ReportCard title="Macro" testId="report-macro">…</ReportCard>
 */
export function ReportCard({ title, subtitle, testId, children, className = "" }: ReportCardProps) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={["min-w-0 overflow-hidden rounded-xl border-2 border-line bg-bg-surface shadow-hard", className]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="space-y-0.5 border-b border-border px-4 py-3">
        <h3 className="font-display text-h4 text-text">{title}</h3>
        {subtitle ? <p className="text-caption text-text-muted">{subtitle}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * "3–1" with the wins and losses tinted; screen readers hear "3 wins, 1 loss".
 *
 * Example:
 *   <WinLoss wins={3} losses={1} />
 */
export function WinLoss({ wins, losses }: { wins: number; losses: number }) {
  return (
    <span className="whitespace-nowrap font-semibold tabular-nums">
      <span className="sr-only">
        {wins} {wins === 1 ? "win" : "wins"}, {losses} {losses === 1 ? "loss" : "losses"}
      </span>
      <span aria-hidden>
        <span className="text-success">{wins}</span>
        <span className="text-text-dim">–</span>
        <span className="text-danger">{losses}</span>
      </span>
    </span>
  );
}

/**
 * Win-rate text ("75%" or "—" when nothing was decided).
 *
 * Example:
 *   <WinrateText wins={3} losses={1} />
 */
export function WinrateText({ wins, losses }: { wins: number; losses: number }) {
  const rate = winratePercent(wins, losses);
  return <span className="tabular-nums text-text-muted">{rate === null ? "—" : `${rate}%`}</span>;
}

/**
 * Thin bar showing the win share of decided games; hidden from assistive
 * tech because the numbers next to it carry the same information.
 *
 * Example:
 *   <WinrateBar wins={3} losses={1} />
 */
export function WinrateBar({ wins, losses }: { wins: number; losses: number }) {
  const rate = winratePercent(wins, losses);
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated">
      {rate === null ? null : <div className="h-full rounded-full bg-success" style={{ width: `${rate}%` }} />}
    </div>
  );
}

const OUTCOME_MARKS = {
  W: { text: "W", label: "Win", tone: "border-success/40 bg-success/15 text-success" },
  L: { text: "L", label: "Loss", tone: "border-danger/40 bg-danger/15 text-danger" },
} as const;

/**
 * A one-letter W / L chip for one game (screen readers hear "Win" /
 * "Loss"); a dash when the game was not decided.
 *
 * Example:
 *   <OutcomeMark outcome="W" />
 */
export function OutcomeMark({ outcome }: { outcome: "W" | "L" | null }) {
  if (!outcome) {
    return (
      <span className="text-text-dim">
        <span aria-hidden>–</span>
        <span className="sr-only">No result</span>
      </span>
    );
  }
  const mark = OUTCOME_MARKS[outcome];
  return (
    <span className={["inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border text-micro font-bold", mark.tone].join(" ")}>
      <span aria-hidden>{mark.text}</span>
      <span className="sr-only">{mark.label}</span>
    </span>
  );
}
