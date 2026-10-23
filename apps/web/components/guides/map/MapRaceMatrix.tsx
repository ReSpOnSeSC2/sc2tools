/* eslint-disable @next/next/no-img-element */
import { WinRateCell } from "../WinRateCell";
import { GUIDE_TABLE_WRAP_CLASS } from "../guideUi";
import { GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS } from "@/lib/guides/guideCopy";
import { fmtCount } from "@/lib/guides/format";
import { getIconPath } from "@/lib/sc2-icons";
import type { GuideMapMatchupRow } from "@/lib/guides/types";

const RACES = [{ letter: "P", name: "Protoss" }, { letter: "T", name: "Terran" }, { letter: "Z", name: "Zerg" }];
export function MapRaceMatrix({ rows }: { rows: readonly GuideMapMatchupRow[] }) {
  const byMatchup = new Map(rows.map((row) => [row.matchup, row]));
  return <div className={GUIDE_TABLE_WRAP_CLASS}><table className="w-full table-fixed text-caption"><caption className="sr-only">Win rate by matchup on this map</caption><thead className="border-b border-border bg-bg-elevated"><tr><td className="w-[24%] p-1 text-left text-micro">You play</td>{RACES.map((race) => <th key={race.letter} scope="col" className="p-1 text-center text-micro font-semibold">vs {race.name}</th>)}</tr></thead><tbody className="divide-y divide-border">{RACES.map((mine) => <tr key={mine.letter}><th scope="row" className="p-1 text-left font-medium"><span className="flex flex-col items-start gap-1 py-2 sm:flex-row sm:items-center"><img src={getIconPath(mine.name, "race") ?? ""} alt="" width={20} height={20} className="h-5 w-5" />{mine.name}</span></th>{RACES.map((opponent) => {
    const row = byMatchup.get(`${mine.letter}v${opponent.letter}` as GuideMapMatchupRow["matchup"]);
    const mirror = mine.letter === opponent.letter;
    const enough = row && row.games >= GUIDE_CELL_MIN_GAMES && row.users >= GUIDE_CELL_MIN_USERS;
    return <td key={opponent.letter} className="p-1 text-center align-middle">{mirror ? <span className="block text-micro text-text-muted">{row ? `${fmtCount(row.games)} games` : "Not enough games"}<span className="block">mirror</span></span> : enough ? <><WinRateCell winRate={row.winRate} ci={row.ci} compact showWhisker={false} /><span className="block text-micro text-text-dim">{fmtCount(row.games)} games</span></> : <span className="text-micro text-text-dim">Not enough games</span>}</td>;
  })}</tr>)}</tbody></table></div>;
}
