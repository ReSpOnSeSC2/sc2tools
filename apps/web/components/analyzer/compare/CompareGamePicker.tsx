"use client";

/**
 * The second-game picker behind the game page's "Compare…". Three smart
 * chips answer the usual questions in one tap — the best recent win with this
 * build, the previous game against this opponent, the last game in this
 * matchup — and a search over your recent games covers everything else.
 * Every list comes from the replay library and game-navigation reads
 * the app already makes; nothing new on the server.
 */

import { useEffect, useId, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useApi } from "@/lib/clientApi";
import { bestWinCandidate, compareHref } from "@/lib/gameCompare";
import { formatClock } from "@/lib/replayHud";
import { ownerNeighborPath } from "@/components/analyzer/game/GameNavigation";
import { resultLabel, type GameSummary } from "@/components/analyzer/game/types";
import type { ReplayLibraryItem, ReplayLibraryResponse } from "@/components/analyzer/replays/types";

type Neighbors = { prev: GameSummary | null; next: GameSummary | null };
type Choice = Pick<ReplayLibraryItem, "gameId" | "result" | "map" | "date" | "durationSec" | "macroScore"> & {
  matchup?: string | null; opponent?: { displayName?: string | null; race?: string | null } | null; myRace?: string | null;
};

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const OPTIONS = { revalidateOnFocus: false, shouldRetryOnError: false } as const;

function describe(choice: Choice): string {
  const matchup = choice.matchup ?? (choice.myRace && choice.opponent?.race ? `${choice.myRace.charAt(0)}v${choice.opponent.race.charAt(0)}` : null);
  return [resultLabel(choice.result), matchup, choice.map, choice.date ? DATE.format(new Date(choice.date)) : null,
    typeof choice.durationSec === "number" ? formatClock(choice.durationSec) : null,
    choice.opponent?.displayName ? `vs ${choice.opponent.displayName}` : null].filter(Boolean).join(" · ");
}

function SmartChip({ title, choice, loading, empty, onPick }: {
  title: string; choice: Choice | null | undefined; loading: boolean; empty: string; onPick: (id: string) => void;
}) {
  return (
    <button type="button" disabled={!choice} onClick={() => choice && onPick(choice.gameId)}
      className="flex min-h-11 w-full flex-col items-start rounded-lg border border-border bg-bg-elevated px-3 py-2 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60">
      <span className="text-caption font-semibold text-text">{title}</span>
      <span className="text-micro text-text-muted">{loading ? "Looking…" : choice ? describe(choice) : empty}</span>
    </button>
  );
}

export default function CompareGamePicker({ open, onClose, game, buildLabel, returnFocusRef }: {
  open: boolean; onClose: () => void; game: GameSummary; buildLabel?: string | null; returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const listId = useId();
  const build = (buildLabel ?? game.myBuild ?? "").trim();
  const winsReq = useApi<ReplayLibraryResponse>(build
    ? `/v1/replays?${new URLSearchParams({ build, result: "win", limit: "25", sort: "date_desc", enrich: "none" })}` : null, OPTIONS);
  const opponentReq = useApi<Neighbors>(game.opponent?.pulseId ? ownerNeighborPath(game.gameId, "opponent") : null, OPTIONS);
  const matchup = game.myRace && game.opponent?.race ? `${game.myRace.charAt(0)}v${game.opponent.race.charAt(0)}` : null;
  const matchupReq = useApi<ReplayLibraryResponse>(matchup
    ? `/v1/replays?${new URLSearchParams({ matchup, limit: "2", sort: "date_desc", enrich: "none" })}` : null, OPTIONS);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim().slice(0, 100)), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const recentReq = useApi<ReplayLibraryResponse>(`/v1/replays?${new URLSearchParams({
    ...(search ? { search } : {}), limit: "8", sort: "date_desc", enrich: "none", window: "recent" })}`, OPTIONS);
  const best = winsReq.data ? bestWinCandidate(winsReq.data.items, game.gameId) : null;
  const recent = (recentReq.data?.items ?? []).filter((item) => item.gameId !== game.gameId);
  const pick = (gameId: string) => { onClose(); router.push(compareHref(game.gameId, gameId)); };
  return (
    <Modal open={open} onClose={onClose} title="Compare with…" description="This game is A. Choose game B." size="md" returnFocusRef={returnFocusRef}>
      <div className="space-y-4" data-testid="compare-picker">
        <div className="grid gap-2">
          <SmartChip title="Best recent win with this build" choice={best} loading={!!build && winsReq.isLoading}
            empty={build ? "No other win with this build yet" : "This game has no build label"} onPick={pick} />
          <SmartChip title="Previous game vs this opponent" choice={opponentReq.data?.prev} loading={!!game.opponent?.pulseId && opponentReq.isLoading}
            empty="No earlier game against this opponent" onPick={pick} />
          <SmartChip title="Last game in this matchup" choice={matchupReq.data?.items.find((item) => item.gameId !== game.gameId)} loading={!!matchup && matchupReq.isLoading}
            empty="No other game in this matchup" onPick={pick} />
        </div>
        <div className="space-y-2">
          <label htmlFor={listId} className="text-caption font-semibold text-text">Or search your recent games</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-dim" aria-hidden />
            <Input id={listId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Player, map, build or strategy" className="pl-9" maxLength={100} />
          </div>
          {recentReq.error ? <p role="alert" className="text-caption text-danger">Couldn&apos;t load your games. Close and try again.</p> : null}
          <ul className="space-y-1" aria-busy={recentReq.isLoading} aria-label="Recent games">
            {recent.map((item) => (
              <li key={item.gameId}>
                <button type="button" onClick={() => pick(item.gameId)} className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-caption text-text hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {describe(item)}
                </button>
              </li>
            ))}
            {!recentReq.isLoading && recentReq.data && !recent.length ? <li className="px-3 text-caption text-text-muted">No games match.</li> : null}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
