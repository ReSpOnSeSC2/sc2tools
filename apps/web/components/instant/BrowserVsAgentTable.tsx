/**
 * BrowserVsAgentTable — an honest side-by-side of analysing replays in the
 * browser versus running the desktop agent, with a link to /download for
 * the live features only the agent can provide.
 *
 * A semantic table with a caption and row headers. At 360px the columns
 * stay readable by wrapping; the table's own container scrolls sideways if
 * it ever has to, so the page itself never does.
 *
 * Example:
 *   <BrowserVsAgentTable className="mt-8" />
 */
import Link from "next/link";
import { Check, X } from "lucide-react";

type Support = { ok: boolean; note?: string };

interface ComparisonRow {
  feature: string;
  browser: Support;
  agent: Support;
}

/** The comparison, in reading order. Keep every claim literally true. */
export const COMPARISON_ROWS: ReadonlyArray<ComparisonRow> = [
  {
    feature: "Analyse your replays with every analyzer tab",
    browser: { ok: true, note: "Same analysis engine as the agent; sign in to keep your games" },
    agent: { ok: true },
  },
  {
    feature: "Live pre-game scouting and OBS overlay data",
    browser: { ok: false, note: "A web page can't read the SC2 client API on localhost:6119" },
    agent: { ok: true },
  },
  {
    feature: "Sync new games while you play, with no tab open",
    browser: { ok: false, note: "Only while a tab is open (Folder Sync in Chrome or Edge)" },
    agent: { ok: true },
  },
  {
    feature: "Accurate engine playback capture",
    browser: { ok: false, note: "Needs StarCraft II installed" },
    agent: { ok: true },
  },
  {
    feature: "OBS scene switching",
    browser: { ok: false },
    agent: { ok: true },
  },
  {
    feature: "Works on Mac, Chromebook and iPad",
    browser: { ok: true },
    agent: { ok: false, note: "Built for Windows PCs; can't run on a Chromebook or iPad" },
  },
  {
    feature: "Nothing to install",
    browser: { ok: true },
    agent: { ok: false },
  },
];

function SupportCell({ support }: { support: Support }) {
  const Icon = support.ok ? Check : X;
  return (
    <td className="px-3 py-2 align-top">
      <span className="flex items-start gap-1.5">
        <Icon className={["mt-0.5 h-4 w-4 flex-shrink-0", support.ok ? "text-success" : "text-danger"].join(" ")} aria-hidden />
        <span>
          <span className="sr-only">{support.ok ? "Yes" : "No"}</span>
          {support.note ? <span className="text-text-muted">{support.note}</span> : null}
        </span>
      </span>
    </td>
  );
}

export interface BrowserVsAgentTableProps {
  className?: string;
}

/**
 * Browser vs desktop agent comparison.
 *
 * Example:
 *   <BrowserVsAgentTable />
 */
export function BrowserVsAgentTable({ className = "" }: BrowserVsAgentTableProps) {
  return (
    <div className={["space-y-3", className].filter(Boolean).join(" ")}>
      <div className="max-w-full overflow-x-auto rounded-xl border-2 border-line bg-bg-surface shadow-hard">
        <table className="w-full min-w-[18rem] border-collapse text-left text-caption">
          <caption className="px-3 pt-3 text-left font-display text-h4 text-text">In your browser vs the desktop agent</caption>
          <thead>
            <tr className="border-b-2 border-line">
              <th scope="col" className="px-3 py-2 font-semibold text-text">Feature</th>
              <th scope="col" className="px-3 py-2 font-semibold text-text">Browser</th>
              <th scope="col" className="px-3 py-2 font-semibold text-text">Desktop agent</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row.feature} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 align-top font-semibold text-text">{row.feature}</th>
                <SupportCell support={row.browser} />
                <SupportCell support={row.agent} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link
        href="/download"
        className={[
          "inline-flex min-h-[44px] items-center rounded-full px-1 text-body font-semibold text-accent underline-offset-4 hover:underline",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        ].join(" ")}
      >
        Install the agent for live features
      </Link>
    </div>
  );
}
