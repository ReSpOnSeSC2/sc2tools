import Link from "next/link";
import { verdictMeta, verdictTextClass } from "./guideUi";
import { GUIDE_STATS_LEGEND } from "@/lib/guides/guideCopy";
import { fmtGuideDate } from "@/lib/guides/format";
import { Term } from "@/components/ui/Term";

/** One server-rendered explanation beside a page's first statistics section. */
export function GuideStatsLegend({ computedAt }: { computedAt: string | null }) {
  return <details className="rounded-lg border border-border bg-bg-surface p-3 text-caption text-text-muted" data-guide-stats-legend>
    <summary className="min-h-11 cursor-pointer py-3 font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{GUIDE_STATS_LEGEND.title}</summary>
    <div className="space-y-3 pt-2"><ul className="space-y-2">{(["win", "even", "loss"] as const).map((kind) => {
      const meta = verdictMeta(kind);
      return <li key={kind} className="flex items-start gap-2"><span aria-hidden className={verdictTextClass(kind)}>{meta.glyph}</span><span>{GUIDE_STATS_LEGEND.verdict[kind]}</span></li>;
    })}</ul><p><strong className="text-text"><Term id="likely-range">{GUIDE_STATS_LEGEND.rangeLabel}</Term>: </strong>{GUIDE_STATS_LEGEND.range}</p><p>{GUIDE_STATS_LEGEND.ranking}</p><p>{GUIDE_STATS_LEGEND.floors}</p><p>{GUIDE_STATS_LEGEND.trend}</p><p>{GUIDE_STATS_LEGEND.updated}{computedAt ? ` · ${GUIDE_STATS_LEGEND.lastUpdate} ${fmtGuideDate(computedAt)}` : ""}</p><Link href="/help/reading-guide-stats" className="font-semibold text-accent underline">{GUIDE_STATS_LEGEND.help}</Link></div>
  </details>;
}
