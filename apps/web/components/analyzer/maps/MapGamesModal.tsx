"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { filtersToQuery, useFilters } from "@/lib/filterContext";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { QueryState } from "@/components/ui/QueryState";
import { AllGamesTable } from "../AllGamesTable";
import type { ProfileGame } from "../Last5GamesTimeline";
import type { MapGamesDrill } from "./MapVetoTable";

type GamesResponse = { total?: number; games: Array<{ id?: string; date?: string; map?: string; opponent?: string; opp_race?: string; result?: string; build?: string; game_length?: number; my_race?: string; macro_score?: number; opponent_pulse_id?: string }> };

/** One bounded, on-demand games page; pool rows never fan out into game requests. */
export function MapGamesModal({ drill, onClose }: { drill: MapGamesDrill | null; onClose: () => void }) {
  const { filters, setFilters, dbRev } = useFilters(); const myName = useMyDisplayName();
  const query = drill ? filtersToQuery({ ...(drill.filters ?? filters), map: drill.map, ...(drill.opponent ? { opp_race: drill.opponent } : {}), sort: "date_desc", limit: 100 }) : null;
  const request = useApi<GamesResponse>(query ? `/v1/games-list${query}#${dbRev}` : null, { keepPreviousData: false });
  const games = useMemo<ProfileGame[]>(() => (request.data?.games ?? []).map((game) => ({ ...game, id: game.id ?? null, date: game.date ?? null, map: game.map ?? null,
    opponent: game.opponent ?? null, opp_race: game.opp_race ?? null, result: game.result ?? null, my_build: game.build ?? null, my_race: game.my_race ?? null, game_length: game.game_length ?? null })), [request.data]);
  return <Modal open={!!drill} onClose={onClose} title={`${drill?.map ?? "Map"}${drill?.opponent ? ` · vs ${drill.opponent}` : ""}`} description="Games behind this map and matchup, using the selected sample filters." size="2xl"
    footer={<Button variant="secondary" onClick={() => { if (drill) setFilters({ ...filters, map: drill.map }); onClose(); }}>Filter everything to this map</Button>}>
    <QueryState q={request} filtered errorTitle="Couldn't load these map games" isEmpty={() => !games.length} empty={<p className="text-caption text-text-muted">No games match this map sample.</p>}>
      {() => <><AllGamesTable games={games} myName={myName} />{(request.data?.total ?? 0) > games.length ? <p className="mt-3 text-micro text-text-dim">Showing the latest {games.length} of {request.data?.total} matching games.</p> : null}</>}
    </QueryState>
  </Modal>;
}
