"use client";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { AdminSearchField } from "./AdminSearchField";
import { AdminTable, AdminMobileSort, type AdminColumn } from "./AdminTable";
import { AdminPagination } from "./AdminPagination";
import { useAdminQueryState } from "./useAdminQueryState";
import { ForbiddenCard } from "./AdminFragments";
import { pctLabel, raceLabel, timeSince } from "./format";
import type { AdminOpponentRow, OpponentsListResp } from "./adminTypes";

type Player = AdminOpponentRow & { trackedByUsers?: number };
const allowed = { race: ["all", "Terran", "Protoss", "Zerg", "Random", "T", "P", "Z", "R", "U"], sort: ["gameCount", "wins", "losses", "winRate", "lastSeen", "firstSeen", "mmr", "trackedByUsers"], order: ["asc", "desc"] };
function columns(global: boolean): AdminColumn<Player>[] {
  return [
    { key: "player", label: "Player", mobile: "title", render: row => <><span>{row.displayNameSample || "—"}</span><span className="block break-all font-mono text-caption text-text-muted">{row.pulseId}</span></> },
    { key: "race", label: "Race", mobile: "field", render: row => raceLabel(row.race) },
    ...([ ["gameCount", "Games"], ["wins", "Wins"], ["losses", "Losses"] ] as const).map(([key, label]): AdminColumn<Player> => ({ key, label, sortKey: key, kind: "number", align: "right", mobile: "field", render: row => row[key].toLocaleString() })),
    { key: "winRate", label: "Win rate", sortKey: "winRate", kind: "number", align: "right", mobile: "field", render: row => pctLabel(row.winRate) },
    { key: "mmr", label: "MMR", sortKey: "mmr", kind: "number", align: "right", mobile: "field", render: row => row.mmr ?? "—" },
    ...(global ? [{ key: "trackedByUsers", label: "Tracked by", sortKey: "trackedByUsers", kind: "number", align: "right", mobile: "field", render: (row: Player) => row.trackedByUsers ?? 0 } as AdminColumn<Player>] : [{ key: "firstSeen", label: "First seen", sortKey: "firstSeen", kind: "date", align: "right", mobile: "hidden", render: (row: Player) => timeSince(row.firstSeen) } as AdminColumn<Player>]),
    { key: "lastSeen", label: "Last seen", sortKey: "lastSeen", kind: "date", align: "right", mobile: "field", render: row => timeSince(row.lastSeen) },
  ];
}

export function AdminPlayersList({ userId }: { userId?: string }) {
  const global = !userId;
  const [state, set] = useAdminQueryState({ q: "", race: "all", minGames: 0, sort: global ? "gameCount" : "lastSeen", order: "desc", page: 0 }, { allowed: { ...allowed, sort: allowed.sort.filter(key => global ? key !== "firstSeen" : key !== "trackedByUsers") } });
  const query = new URLSearchParams({ limit: "50", page: String(state.page), sort: state.sort, order: state.order });
  if (state.q.trim()) query.set("search", state.q.trim());
  if (state.race !== "all") query.set("race", state.race);
  if (state.minGames > 0) query.set("minGames", String(state.minGames));
  const base = global ? "/v1/admin/global/players" : `/v1/admin/users/${encodeURIComponent(userId!)}/opponents`;
  const request = useApi<Omit<OpponentsListResp, "items"> & { items: Player[] }>(`${base}?${query}`, { keepPreviousData: true });
  const rows = request.data?.items || [], total = request.data?.total || 0, cols = columns(global);
  const sort = { by: state.sort, dir: state.order as "asc" | "desc", onChange: (by: string, dir: "asc" | "desc") => set({ sort: by, order: dir }) };
  if (request.error?.status === 403) return <ForbiddenCard />;
  return <section className="space-y-4">{global ? <h2 className="text-h2">Players</h2> : null}<Card padded><div className="grid gap-3 sm:grid-cols-3">
    <AdminSearchField value={state.q} onChange={q => set({ q })} placeholder="Name or Pulse ID" />
    <Field label="Race"><Select value={state.race} onChange={event => set({ race: event.target.value })}><option value="all">All races</option>{[...new Set([...(request.data?.races || []), ...(state.race !== "all" ? [state.race] : [])])].map(race => <option key={race} value={race}>{raceLabel(race)}</option>)}</Select></Field>
    <Field label="Min games"><Input type="number" min={0} inputMode="numeric" value={state.minGames || ""} onChange={event => set({ minGames: Number(event.target.value) || 0 })} placeholder="0" /></Field>
  </div><AdminMobileSort columns={cols} sort={sort} /></Card>
    <AdminTable columns={cols} rows={rows} rowKey={row => row.pulseId} rowHref={row => global ? `/admin/global/players/${encodeURIComponent(row.pulseId)}` : `/admin/users/${encodeURIComponent(userId!)}/opponents/${encodeURIComponent(row.pulseId)}`} sort={sort} loading={!request.data && request.isLoading} updating={!!request.data && request.isValidating} caption={global ? "Global players" : "Account opponents"}
      error={request.error ? <RequestError error={request.error} onRetry={() => request.mutate()} /> : null} empty={<EmptyStatePanel title="No players match these filters" action={<Button variant="secondary" onClick={() => { set({ q: "", race: "all", minGames: 0 }); void request.mutate(); }}>Clear filters</Button>} />} />
    <AdminPagination hasPrev={state.page > 0} hasNext={!!request.data?.hasMore} onPrev={() => set({ page: Math.max(0, state.page - 1) })} onNext={() => set({ page: state.page + 1 })} label={`${total ? state.page * 50 + 1 : 0}–${state.page * 50 + rows.length} of ${total.toLocaleString()}`} loading={request.isValidating} itemCount={rows.length} />
  </section>;
}
