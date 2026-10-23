import type { SortComparators, SortDir } from "@/components/ui/SortableTh";
import { pickPulseLabel } from "@/lib/sc2pulse";

const names = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
type Row = { name?: string; pulseId: string; pulseCharacterId?: string | null; toonHandle?: string | null; games?: number; winRate?: number };
const direction = (dir: SortDir) => dir === "asc" ? 1 : -1;
export function visibleOpponentId(row: Row): string | undefined { return pickPulseLabel(row)?.value; }

export const OPPONENT_COMPARATORS: SortComparators = {
  name: (left, right, dir) => names.compare((left as Row).name || "", (right as Row).name || "") * direction(dir),
  pulseId: (left, right, dir) => {
    const a = visibleOpponentId(left as Row) || ""; const b = visibleOpponentId(right as Row) || "";
    const aNumber = /^\d+$/.test(a); const bNumber = /^\d+$/.test(b);
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return (aNumber ? Number(a) - Number(b) : names.compare(a, b)) * direction(dir);
  },
  winRate: (left, right, dir) => {
    const a = left as Row; const b = right as Row;
    return ((a.winRate || 0) - (b.winRate || 0)) * direction(dir) || (b.games || 0) - (a.games || 0) || names.compare(a.name || "", b.name || "");
  },
};
