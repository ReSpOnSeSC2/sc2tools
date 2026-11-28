import type { ReactNode } from "react";
import { formatRelative } from "@/lib/i18n/format";
import type { ProBoard } from "@/lib/ladder/proBoard";
import { PlayerTile } from "./PlayerTile";
import { ProCard } from "./ProCard";

/** `items-start`: a card is as tall as its own content, so a pro with no games has no empty space beside one with three. */
export const CARD_GRID = "grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3";
export const TILE_GRID = "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6";

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-0.5">
        <h2 id={id} className="font-display text-h3 font-semibold text-text">{title}</h2>
        <p className="text-caption text-text-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

const EMPTY = "rounded-xl border border-line bg-bg-surface p-4 text-body text-text-muted";

/** The board as the last refresh left it. With names off there is one section and no pro is told apart. */
export function ProBoardSections({ board, now }: { board: ProBoard; now: number }) {
  const { showNames, pros, players } = board;
  const updated = `Updated ${formatRelative(board.fetchedAt, now)}.`;
  if (pros.length === 0 && players.length === 0) {
    return (
      <Section id="players-now" title="Playing now" note={`Grandmaster games in the last hour. ${updated}`}>
        <p role="status" className={EMPTY}>No Grandmaster ladder game in the last hour was found. Try again soon.</p>
      </Section>
    );
  }
  return (
    <div className="space-y-8">
      {showNames && pros.length > 0 && (
        <Section id="pros-now" title="Pros playing now" note="Known pros with a ladder game in the last hour, newest first.">
          <ul className={CARD_GRID}>{pros.map(pro => <ProCard key={`${pro.nickname}-${pro.playedAt}`} pro={pro} now={now} />)}</ul>
        </Section>
      )}
      {players.length > 0 && (
        <Section
          id="players-now"
          title={showNames && pros.length > 0 ? "Also playing now" : "Playing now"}
          note={`Grandmaster games in the last hour, strongest first. ${updated}`}
        >
          <ul className={TILE_GRID}>{players.map((player, index) => <PlayerTile key={index} player={player} />)}</ul>
        </Section>
      )}
    </div>
  );
}
