/**
 * The /try game picker: one toggle button per game, newest first, with
 * its date, map, matchup, W/L, opponent and — when the replay recorded
 * both — the two pre-game MMRs. The pressed button is the game shown
 * below the list. Long lists scroll inside the picker, not the page.
 *
 * Example:
 *   <GameList games={report.games} selectedId={id} onSelect={setId} />
 */
import type { ReportGame } from "@/lib/instant/report";
import { formatMmr } from "@/lib/instant/reportMmr";
import { OutcomeMark, formatReportDate } from "./ReportBits";

export interface GameListProps {
  games: ReportGame[];
  selectedId: string;
  onSelect: (gameId: string) => void;
}

/**
 * "You 5,326 · Opp 5,118 pre-game MMR", or null unless both pre-game
 * MMRs exist. Says "pre-game" because a replay never records the rating
 * after the game, so a number beside a win must not read as its result.
 *
 * Example:
 *   mmrPairLabel({ my: 5326, opp: 5118, gap: 208 }); // -> "You 5,326 · Opp 5,118 pre-game MMR"
 */
export function mmrPairLabel(mmr: ReportGame["mmr"]): string | null {
  return mmr ? `You ${formatMmr(mmr.my)} · Opp ${formatMmr(mmr.opp)} pre-game MMR` : null;
}

function GameRowButton({ game, selected, onSelect }: { game: ReportGame; selected: boolean; onSelect: (id: string) => void }) {
  const date = formatReportDate(game.date);
  const mmr = mmrPairLabel(game.mmr);
  const second = [game.opponentName ? `vs ${game.opponentName}` : null, mmr].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(game.gameId)}
      className={[
        "flex min-h-[44px] w-full flex-col gap-0.5 rounded-lg border-2 px-3 py-2 text-left transition-colors motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        selected ? "border-accent bg-bg-elevated" : "border-border hover:border-line",
      ].join(" ")}
    >
      <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
        <OutcomeMark outcome={game.outcome} />
        {game.matchup ? <span className="font-semibold text-text">{game.matchup}</span> : null}
        {game.map ? <span className="min-w-0 break-words text-text">{game.map}</span> : null}
        {date ? <span className="ml-auto whitespace-nowrap tabular-nums text-text-muted">{date}</span> : null}
      </span>
      {second ? <span className="min-w-0 break-words text-micro tabular-nums text-text-muted">{second}</span> : null}
    </button>
  );
}

/**
 * The list of games; the pressed one is shown in detail.
 *
 * Example:
 *   <GameList games={games} selectedId={games[0].gameId} onSelect={() => {}} />
 */
export function GameList({ games, selectedId, onSelect }: GameListProps) {
  return (
    <ul aria-label="Your games" className="max-h-80 space-y-2 overflow-y-auto p-1" data-testid="report-game-list">
      {games.map((game) => (
        <li key={game.gameId}>
          <GameRowButton game={game} selected={game.gameId === selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}
