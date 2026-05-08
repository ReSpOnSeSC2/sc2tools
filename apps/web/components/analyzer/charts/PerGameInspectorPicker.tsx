"use client";

import { CalendarDays, MapPin, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { fmtDate, fmtMinutes } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";

/**
 * Game picker for ``PerGameInspector``. Shows a searchable, scrollable
 * list of recent replays; selection is lifted to the parent so the
 * detail pane can render in lock-step with the picker on desktop and
 * swap with it on mobile.
 *
 * Pulled into its own file so ``PerGameInspector.tsx`` stays under the
 * 800-line cap.
 */
export interface PickerGame {
  id: string;
  date?: string;
  map?: string;
  opponent?: string;
  opp_race?: string;
  result?: string;
  build?: string;
  game_length?: number;
  macro_score?: number | null;
  my_race?: string;
}

export interface GamePickerProps {
  games: PickerGame[];
  totalGames: number;
  isLoading: boolean;
  error?: string;
  search: string;
  onSearch: (next: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function GamePicker({
  games,
  totalGames,
  isLoading,
  error,
  search,
  onSearch,
  selectedId,
  onSelect,
}: GamePickerProps) {
  return (
    <Card padded={false} className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Recent replays
          </h3>
          <span className="text-[11px] tabular-nums text-text-dim">
            {totalGames}
          </span>
        </div>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Filter by opponent, map, build…"
            aria-label="Filter recent replays"
            className="pl-8"
          />
        </div>
      </div>
      <div className="max-h-[70vh] flex-1 overflow-y-auto lg:max-h-[80vh]">
        {error ? (
          <p className="p-3 text-caption text-danger">{error}</p>
        ) : isLoading ? (
          <div className="p-3">
            <Skeleton rows={6} />
          </div>
        ) : games.length === 0 ? (
          <EmptyState
            title="No replays match"
            sub={
              search
                ? "Try a different search or clear the filter."
                : "Sync some replays from the desktop agent and they'll appear here."
            }
          />
        ) : (
          <ul role="listbox" aria-label="Recent replays">
            {games.map((g) => (
              <li key={g.id}>
                <GamePickerRow
                  game={g}
                  selected={g.id === selectedId}
                  onSelect={() => onSelect(g.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function GamePickerRow({
  game,
  selected,
  onSelect,
}: {
  game: PickerGame;
  selected: boolean;
  onSelect: () => void;
}) {
  const result = (game.result || "").toLowerCase();
  const isWin = ["win", "victory"].includes(result);
  const oppRace = coerceRace(game.opp_race);
  const tint = raceTint(oppRace);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={[
        "block w-full border-b border-border px-3 py-2.5 text-left transition-colors min-h-[60px]",
        "focus-visible:outline-none focus-visible:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
        selected
          ? "bg-bg-elevated/80 border-l-2 border-l-accent"
          : "hover:bg-bg-elevated/50 active:bg-bg-elevated/70",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2 text-caption">
        <Badge size="sm" variant={isWin ? "success" : "danger"}>
          {isWin ? "Win" : "Loss"}
        </Badge>
        <span className="font-mono text-[11px] text-text-dim">
          {fmtDate(game.date)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-body text-text">
        <Icon name={raceIconName(oppRace)} kind="race" size={14} decorative />
        <span className={["truncate", tint.text].join(" ")}>
          {game.opponent || "Unknown"}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1 truncate">
          <MapPin className="h-3 w-3" aria-hidden />
          {game.map || "—"}
        </span>
        {game.game_length ? (
          <span className="inline-flex items-center gap-1 tabular-nums text-text-dim">
            <CalendarDays className="h-3 w-3" aria-hidden />
            {fmtMinutes(game.game_length)}
          </span>
        ) : null}
        <MacroPill score={game.macro_score} />
      </div>
    </button>
  );
}

function MacroPill({ score }: { score: number | null | undefined }) {
  if (score == null) {
    return <span className="text-text-dim">macro —</span>;
  }
  const tone =
    score >= 75 ? "text-success" : score >= 50 ? "text-warning" : "text-danger";
  return (
    <span className={["tabular-nums", tone].join(" ")}>
      macro {score.toFixed(0)}
    </span>
  );
}
