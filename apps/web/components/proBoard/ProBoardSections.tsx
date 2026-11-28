import type { ReactNode } from "react";
import { formatRelative } from "@/lib/i18n/format";
import type { ProBoard } from "@/lib/ladder/proBoard";
import { PlayerTile } from "./PlayerTile";
import { ProCard } from "./ProCard";

export const CARD_GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";
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

/** The board as the last refresh left it. With names off there is one section and no pro is told apart. */
export function ProBoardSections({ board, now }: { board: ProBoard; now: number }) {
  const { showNames, pros, players } = board;
  return (
    <div className="space-y-8">
      {showNames && (
        <Section id="pros-now" title="Pros playing now" note="Known pros with a ladder game in the last hour, newest first.">
          {pros.length > 0 ? (
            <ul className={CARD_GRID}>{pros.map(pro => <ProCard key={`${pro.nickname}-${pro.playedAt}`} pro={pro} now={now} />)}</ul>
          ) : (
            <p role="status" className="rounded-xl border border-line bg-bg-surface p-4 text-body text-text-muted">No known pro has played a ladder game in the last hour.</p>
          )}
        </Section>
      )}
      <Section
        id="players-now"
        title={showNames ? "Also playing now" : "Playing now"}
        note={`Grandmaster games in the last hour, newest first. Updated ${formatRelative(board.fetchedAt, now)}.`}
      >
        {players.length > 0 ? (
          <ul className={TILE_GRID}>{players.map((player, index) => <PlayerTile key={`${player.playedAt}-${index}`} player={player} now={now} />)}</ul>
        ) : (
          <p role="status" className="rounded-xl border border-line bg-bg-surface p-4 text-body text-text-muted">No Grandmaster ladder game in the last hour was found. Try again soon.</p>
        )}
      </Section>
    </div>
  );
}
