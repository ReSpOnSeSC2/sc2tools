/* eslint-disable @next/next/no-img-element */
import { GuideSection as Section } from "@/components/guides/GuideSection";
import { GUIDE_PANEL_CLASS, GUIDE_TABLE_WRAP_CLASS, unitDisplayName } from "@/components/guides/guideUi";
import { ArmyMobileTabs } from "./ArmyMobileTabs";
import { fmtClock, fmtCount, fmtPresence } from "@/lib/guides/format";
import { getIconPath } from "@/lib/sc2-icons";
import type { GuideArmy, GuideArmyCheckpoint, GuideArmyCheckpointKey, GuideArmyUnit } from "@/lib/guides/types";

export const ARMY_CHECKPOINTS: readonly GuideArmyCheckpointKey[] = ["360", "480", "600"];
export const ARMY_CAPTION = "Typical count in games that built it · how often it appears";
const UNIT_COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export function fmtUnitCount(median: number): string { return Number.isFinite(median) ? UNIT_COUNT_FORMAT.format(median) : fmtCount(median); }

function UnitName({ unit }: { unit: string }) {
  const icon = getIconPath(unit, "unit");
  return <span className="inline-flex items-center gap-2">{icon ? <img src={icon} alt="" width={28} height={28} loading="lazy" className="h-7 w-7 shrink-0 rounded-md border border-border bg-bg-elevated" /> : <span aria-hidden className="h-7 w-7 shrink-0 rounded-md bg-bg-elevated" />}<span>{unitDisplayName(unit)}</span></span>;
}
function CheckpointCard({ seconds, checkpoint }: { seconds: number; checkpoint: GuideArmyCheckpoint }) {
  return <div className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}><h3 className="font-display text-h4 font-bold">At {fmtClock(seconds)}</h3><p className="mb-3 text-micro text-text-dim">{ARMY_CAPTION} · {fmtCount(checkpoint.samples)} replays</p><ul className="space-y-2">{checkpoint.units.map((unit) => <li key={unit.unit} className="flex items-center justify-between gap-2"><UnitName unit={unit.unit} /><span className="text-right text-caption tabular-nums"><span className="font-semibold">×{fmtUnitCount(unit.median)}</span><span className="block text-micro text-text-dim">in {fmtPresence(unit.presence)} of games</span></span></li>)}</ul></div>;
}

/** Units present later sort first; ties move back through the earlier snapshots. */
export function armyUnitOrder(army: GuideArmy): string[] {
  const units = [...new Set(ARMY_CHECKPOINTS.flatMap((key) => army[key]?.units.map((unit) => unit.unit) ?? []))];
  const presence = (name: string, key: GuideArmyCheckpointKey) => army[key]?.units.find((unit) => unit.unit === name)?.presence ?? 0;
  return units.sort((a, b) => presence(b, "600") - presence(a, "600") || presence(b, "480") - presence(a, "480") || presence(b, "360") - presence(a, "360") || a.localeCompare(b, "en"));
}
function ArmyCell({ unit }: { unit: GuideArmyUnit | undefined }) {
  if (!unit) return <><span aria-hidden>—</span><span className="sr-only">not built</span></>;
  return <div className="space-y-1 text-caption tabular-nums"><span className="font-semibold">×{fmtUnitCount(unit.median)}</span><div aria-hidden className="h-1 w-16 max-w-full rounded bg-bg-elevated"><div className="h-1 rounded bg-accent" style={{ width: `${Math.max(0, Math.min(1, unit.presence)) * 100}%` }} /></div><span className="text-micro text-text-muted">{fmtPresence(unit.presence)}</span></div>;
}
function ArmyTable({ army, columns }: { army: GuideArmy; columns: readonly GuideArmyCheckpointKey[] }) {
  return <div className={`hidden md:block ${GUIDE_TABLE_WRAP_CLASS}`}><table className="w-full text-caption"><caption className="p-3 text-left text-text-muted">{ARMY_CAPTION}</caption><thead className="border-b border-border bg-bg-elevated"><tr><th scope="col" className="sticky left-0 z-10 bg-bg-elevated p-3 text-left">Unit</th>{columns.map((key) => <th key={key} scope="col" className="p-3 text-left">{fmtClock(Number(key))}</th>)}</tr></thead><tbody className="divide-y divide-border">{armyUnitOrder(army).map((name) => <tr key={name}><th scope="row" className="sticky left-0 z-10 bg-bg-surface p-3 text-left font-medium"><UnitName unit={name} /></th>{columns.map((key) => <td key={key} className="p-3"><ArmyCell unit={army[key]?.units.find((unit) => unit.unit === name)} /></td>)}</tr>)}</tbody></table></div>;
}
export function BuildArmySection({ army }: { army: GuideArmy | null }) {
  if (!army) return null;
  const columns = ARMY_CHECKPOINTS.filter((key) => Boolean(army[key]?.units.length));
  if (!columns.length) return null;
  const cards = columns.map((key) => ({ key, label: fmtClock(Number(key)), content: <CheckpointCard seconds={Number(key)} checkpoint={army[key]!} /> }));
  return <Section id="army" title="Army at 6, 8 and 10 minutes"><ArmyTable army={army} columns={columns} /><ArmyMobileTabs cards={cards} />{ARMY_CHECKPOINTS.filter((key) => !columns.includes(key)).map((key) => <p key={key} className="mt-3 text-caption text-text-muted">Not enough games reach {fmtClock(Number(key))}</p>)}</Section>;
}
