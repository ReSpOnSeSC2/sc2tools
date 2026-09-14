"use client";

import { useMemo } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, Skeleton } from "@/components/ui/Card";
import { AllGamesTable } from "../AllGamesTable";
import type { ProfileGame } from "../Last5GamesTimeline";
import { fmtDate, fmtMinutes } from "@/lib/format";

type Band = { lo: number; hi: number; wins: number; losses: number; total: number };

type Response = {
  ok: boolean;
  lo: number | null;
  hi: number | null;
  total: number;
  count: number;
  games: Array<ProfileGame & { playerId?: string; playerName?: string }>;
};

/**
 * Drilldown behind a single "Win rate by opponent MMR" tile. Fetches
 * exactly the games whose effective opponent MMR lands in the band
 * (same derivation the histogram bins with) and lists them through
 * the shared AllGamesTable — same macro-breakdown popover and
 * expandable build orders the opponent-profile list offers, plus the
 * per-game opponent name + opponent MMR so the user can confirm a
 * surprising bracket is real.
 */
export function OppMmrBucketGamesModal({
  band,
  onClose,
}: {
  band: Band | null;
  onClose: () => void;
}) {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const open = band != null;

  const query = useMemo(() => {
    if (!band) return null;
    return { ...filters, lo: band.lo, hi: band.hi };
  }, [filters, band]);

  const { data, isLoading, error } = useApi<Response>(
    open && query
      ? `/v1/opp-mmr-buckets/games${filtersToQuery(query)}#${dbRev}`
      : null,
  );

  if (!band) return null;

  const games = data?.games || [];
  const wr = band.total > 0 ? Math.round((band.wins / band.total) * 100) : 0;
  const description = `${band.wins}W · ${band.losses}L · ${band.total} game${
    band.total === 1 ? "" : "s"
  } · ${wr}% win rate`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      title={`Opponents at ${band.lo}–${band.hi - 1} MMR`}
      description={description}
    >
      {isLoading ? (
        <Skeleton rows={5} />
      ) : error ? (
        <p className="text-sm text-danger">{error.message}</p>
      ) : games.length === 0 ? (
        <EmptyState
          title="No games in this band"
          sub="These games may have dropped out under the current filters."
        />
      ) : (
        <>
          {isGlobal ? <GlobalBucketGames games={games} /> : <PersonalBucketGames games={games} />}
          {data && data.total > games.length ? (
            <p className="mt-3 text-micro text-text-dim">
              Showing the {games.length.toLocaleString()} most recent of{" "}
              {data.total.toLocaleString()} games in this band.
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function PersonalBucketGames({ games }: { games: ProfileGame[] }) {
  const myName = useMyDisplayName();
  return <AllGamesTable games={games} myName={myName} />;
}

/** Global drilldowns keep each player's perspective without personal replay actions. */
function GlobalBucketGames({ games }: { games: Response["games"] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table aria-label="Player game records in MMR band" className="w-full min-w-[680px] text-left text-xs">
        <thead className="bg-bg-elevated text-micro uppercase tracking-wide text-text-dim">
          <tr>{["Player", "Date", "Result", "Opponent", "Opponent MMR", "Map", "Length"].map((label) => <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>)}</tr>
        </thead>
        <tbody>
          {games.map((game, index) => (
            <tr key={`${game.playerId ?? "player"}:${game.id ?? index}`} className="border-t border-border">
              <th scope="row" className="max-w-40 truncate px-3 py-2 font-medium text-text" title={game.playerName || game.playerId}>{game.playerName || game.playerId || "Unknown player"}</th>
              <td className="whitespace-nowrap px-3 py-2 text-text-muted">{fmtDate(game.date)}</td>
              <td className={`px-3 py-2 font-medium ${/^(win|victory)$/i.test(game.result || "") ? "text-success" : /^(loss|defeat)$/i.test(game.result || "") ? "text-danger" : "text-text-muted"}`}>{game.result || "—"}</td>
              <td className="max-w-40 truncate px-3 py-2 text-text-muted" title={game.opponent || undefined}>{game.opponent || "Unknown"}{game.opp_race ? ` (${game.opp_race})` : ""}</td>
              <td className="px-3 py-2 tabular-nums text-text-muted">{game.opp_mmr?.toLocaleString() ?? "—"}</td>
              <td className="max-w-44 truncate px-3 py-2 text-text-muted" title={game.map || undefined}>{game.map || "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-muted">{game.game_length ? fmtMinutes(game.game_length) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
