import { CiWhisker } from "@/components/guides/CiWhisker";
import { cellVerdict, verdictMeta, verdictTextClass } from "@/components/guides/guideUi";
import { fmtCi, fmtPct } from "@/lib/guides/format";
import type { GuideCi } from "@/lib/guides/types";

/**
 * Win rate + 95% interval for a table cell: the number (green when the
 * whole interval is above 50%, red when below), the whisker glyph and
 * the range as text so the table reads without the glyph.
 */
export function WinRateCell({
  winRate,
  ci,
  showWhisker = true,
  compact = false,
}: {
  winRate: number;
  ci: GuideCi;
  showWhisker?: boolean;
  compact?: boolean;
}) {
  const tone = verdictTextClass(cellVerdict({ ci }));
  const verdict = verdictMeta(cellVerdict({ ci }));
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-2">
        {showWhisker ? <CiWhisker cell={{ winRate, ci }} showVerdict={false} /> : null}
        <span className={`font-semibold tabular-nums ${tone}`}><span aria-hidden>{verdict.glyph} </span>{fmtPct(winRate)}<span className="sr-only">, {verdict.phrase}</span></span>
      </span>
      <span className={compact ? "sr-only sm:not-sr-only sm:text-micro sm:tabular-nums sm:text-text-dim" : "text-micro tabular-nums text-text-dim"}>
        <span className="sr-only">likely range </span>
        {fmtCi(ci)}
      </span>
    </span>
  );
}
