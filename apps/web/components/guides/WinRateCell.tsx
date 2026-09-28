import { CiWhisker } from "@/components/guides/CiWhisker";
import { cellVerdict, verdictTextClass } from "@/components/guides/guideUi";
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
}: {
  winRate: number;
  ci: GuideCi;
  showWhisker?: boolean;
}) {
  const tone = verdictTextClass(cellVerdict({ ci }));
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-2">
        {showWhisker ? <CiWhisker cell={{ winRate, ci }} /> : null}
        <span className={`font-semibold tabular-nums ${tone}`}>{fmtPct(winRate)}</span>
      </span>
      <span className="text-micro tabular-nums text-text-dim">
        <span className="sr-only">likely range </span>
        {fmtCi(ci)}
      </span>
    </span>
  );
}
