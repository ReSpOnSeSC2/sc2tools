/* eslint-disable @next/next/no-img-element */

import { Section } from "@/components/ui/Section";
import { GUIDE_PANEL_CLASS, unitDisplayName } from "@/components/guides/guideUi";
import { fmtClock, fmtCount, fmtPctWhole } from "@/lib/guides/format";
import { getIconPath } from "@/lib/sc2-icons";
import type { GuideArmy, GuideArmyCheckpoint, GuideArmyCheckpointKey } from "@/lib/guides/types";

/**
 * Section 4: the army on the field at 6, 8 and 10 minutes — for each
 * unit, the median count in games that had it and how often it shows
 * up. A missing checkpoint (no replay reached it) is simply not shown.
 * Icons are local /public files rendered as plain sized <img> (no CLS).
 */

const CHECKPOINTS: ReadonlyArray<GuideArmyCheckpointKey> = ["360", "480", "600"];
const ICON_SIZE = 28;
/** Interpolated medians can land between counts ("2.5"); keep one decimal. */
const UNIT_COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Median unit count as printed: whole counts plain, an interpolated
 * median with one decimal (never rounded up to a count nobody fielded).
 *
 * Example: `fmtUnitCount(4)` → "4"; `fmtUnitCount(2.5)` → "2.5".
 */
export function fmtUnitCount(median: number): string {
  return Number.isFinite(median) ? UNIT_COUNT_FORMAT.format(median) : fmtCount(median);
}

function UnitRow({ unit }: { unit: GuideArmyCheckpoint["units"][number] }) {
  const icon = getIconPath(unit.unit, "unit");
  const name = unitDisplayName(unit.unit);
  return (
    <li className="flex items-center gap-2">
      {icon ? (
        <img
          src={icon}
          alt=""
          width={ICON_SIZE}
          height={ICON_SIZE}
          loading="lazy"
          className="h-7 w-7 shrink-0 rounded-md border border-border bg-bg-elevated"
        />
      ) : (
        <span aria-hidden className="h-7 w-7 shrink-0 rounded-md border border-border bg-bg-elevated" />
      )}
      <span className="min-w-0 flex-1 truncate text-caption text-text">{name}</span>
      <span className="text-right text-caption tabular-nums">
        <span className="font-semibold text-text">×{fmtUnitCount(unit.median)}</span>
        <span className="block text-micro text-text-dim">in {fmtPctWhole(unit.presence)} of games</span>
      </span>
    </li>
  );
}

function CheckpointCard({ seconds, checkpoint }: { seconds: number; checkpoint: GuideArmyCheckpoint }) {
  return (
    <div className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}>
      <h3 className="font-display text-h4 font-bold text-text">At {fmtClock(seconds)}</h3>
      <p className="mb-3 text-micro text-text-dim">
        Median count when present · {fmtCount(checkpoint.samples)} replays
      </p>
      <ul className="space-y-2">
        {checkpoint.units.map((unit) => (
          <UnitRow key={unit.unit} unit={unit} />
        ))}
      </ul>
    </div>
  );
}

export function BuildArmySection({ army }: { army: GuideArmy | null }) {
  if (!army) return null;
  const cards = CHECKPOINTS.flatMap((key) => {
    const checkpoint = army[key];
    return checkpoint && checkpoint.units.length > 0 ? [{ key, checkpoint }] : [];
  });
  if (cards.length === 0) return null;
  return (
    <Section id="army" title="Army at 6, 8 and 10 minutes">
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map(({ key, checkpoint }) => (
          <CheckpointCard key={key} seconds={Number(key)} checkpoint={checkpoint} />
        ))}
      </div>
    </Section>
  );
}
