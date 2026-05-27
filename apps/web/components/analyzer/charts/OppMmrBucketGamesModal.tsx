"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, Skeleton } from "@/components/ui/Card";
import { AllGamesTable } from "../AllGamesTable";
import type { ProfileGame } from "../Last5GamesTimeline";

type Band = { lo: number; hi: number; wins: number; losses: number; total: number };

type Response = {
  ok: boolean;
  lo: number | null;
  hi: number | null;
  total: number;
  count: number;
  games: ProfileGame[];
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
  const myName = useMyDisplayName();
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
          <AllGamesTable games={games} myName={myName} />
          {data && data.total > games.length ? (
            <p className="mt-3 text-[11px] text-text-dim">
              Showing the {games.length.toLocaleString()} most recent of{" "}
              {data.total.toLocaleString()} games in this band.
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
