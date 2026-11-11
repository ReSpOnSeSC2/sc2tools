"use client";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { useAdminQueryState } from "../../../../components/useAdminQueryState";
import { useAdminCursor } from "../../../../components/useAdminCursor";
import { AdminSelectedGame } from "../../../../components/AdminSelectedGame";
import { AdminGamesMasterDetail } from "../../../../components/AdminGamesMasterDetail";
import { AdminGameFilters } from "../../../../components/AdminGameFilters";
import { OpponentSummaryStrip } from "../../../../components/OpponentSummaryStrip";
import { RESULT_FILTERS, type AdminResultFilter } from "../../../../components/adminResult";
import { AdminPagination } from "@/app/admin/components/AdminPagination";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { Suspense, use } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { OpponentDiagnosticsPanel } from "@/components/analyzer/OpponentDiagnosticsPanel";
import { ForbiddenCard, LoadingRows } from "../../../../components/AdminFragments";
import type {
  OpponentGamesResp,
} from "../../../../components/adminTypes";

const PAGE_SIZE = 50;

/**
 * /admin/users/[userId]/opponents/[pulseId] — every game the user
 * played against one opponent, with each game's full build order
 * (player + opponent) rendered exactly like the user's own replay
 * view (reuses AdminGameDetail).
 *
 * A head-to-head strip (every game vs this opponent) sits above the
 * shared AdminGamesMasterDetail: the games list with result/map filters
 * kept in the URL on the left, the selected game on the right. On mobile
 * the two swap so only one shows at a time, with a back affordance.
 */
function OpponentGamesBody({
  params,
}: {
  params: Promise<{ userId: string; pulseId: string }>;
}) {
  const { userId, pulseId } = use(params);

  const [view, setView] = useAdminQueryState({ game: "", before: "", result: "all", map: "" }, { allowed: { result: RESULT_FILTERS } });
  const before = view.before;
  const result = view.result as AdminResultFilter;
  const paging = useAdminCursor(before, before => setView({ before }));
  const base = `/v1/admin/users/${encodeURIComponent(userId)}/opponents/${encodeURIComponent(pulseId)}/games`;
  const query = (limit: number, cursor: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("before", cursor);
    if (result !== "all") params.set("result", result);
    if (view.map) params.set("map", view.map);
    return `${base}?${params.toString()}`;
  };

  const { data, error, isLoading, isValidating, mutate } = useApi<OpponentGamesResp>(query(PAGE_SIZE, before), { keepPreviousData: true });
  // The summary rides the first page only; an older page (or a shared link
  // to one) asks for it with a one-game first page.
  const first = useApi<OpponentGamesResp>(before ? query(1, "") : null, { keepPreviousData: true });
  const summary = (before ? first.data : data)?.summary ?? null;

  const items = data?.items || [];
  const selected = items.find(g => g.gameId === view.game);
  const filtered = result !== "all" || !!view.map;

  if (error && error.status === 403) return <ForbiddenCard />;

  const oppName = items[0]?.opponent.displayName || "";

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="users-and-repairing-data" title="Opponent" description="Inspect this account’s games against one opponent." actions={<><Link
          href={`/admin/users/${encodeURIComponent(userId)}/opponents`}
          className="text-caption text-text-dim hover:text-text"
        >
          ← All opponents
        </Link></>} />
      <p className="break-all text-body text-text">{oppName || "Opponent"} · <span className="font-mono text-caption">{pulseId}</span></p>

      <OpponentDiagnosticsPanel
        diagnosticsPath={`/v1/admin/users/${encodeURIComponent(
          userId,
        )}/opponents/${encodeURIComponent(pulseId)}/diagnostics`}
        retryPath={`/v1/admin/users/${encodeURIComponent(
          userId,
        )}/opponents/${encodeURIComponent(pulseId)}/retry-pulse`}
      />

      {summary ? <OpponentSummaryStrip summary={summary} /> : null}

      {error && data ? <RequestError error={error} onRetry={() => mutate()} /> : null}
      {error && !data ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : items.length === 0 && !view.game && !filtered ? (
        <Card padded>
          <EmptyStatePanel title="No games recorded against this opponent" action={<Button variant="secondary" onClick={() => void mutate()}>Refresh</Button>} />
        </Card>
      ) : (
        <AdminGamesMasterDetail
          games={items}
          gameKey={g => g.gameId}
          selectedKey={view.game || null}
          onSelect={g => setView({ game: g.gameId })}
          label={`Games against ${oppName || "this opponent"}`}
          busy={isValidating}
          status={<>{items.length === 0 && filtered ? "No games match these filters." : `${items.length} games`}{data && isValidating ? " · Updating…" : ""}</>}
          filters={<div className="space-y-2">
            <AdminGameFilters result={result} map={view.map} maps={summary?.mapOptions || []}
              onResult={value => setView({ result: value })} onMap={value => setView({ map: value })} />
            {filtered ? <Button size="sm" variant="ghost" onClick={() => setView({ result: "all", map: "" })}>Clear filters</Button> : null}
          </div>}
          pagination={<AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={items.length} />}
          detail={view.game ? <AdminSelectedGame userId={userId} gameId={view.game} row={selected} onClear={() => setView({ game: "" })} /> : null}
          placeholder="Select a game to view its build orders."
        />
      )}
    </div>
  );
}

export default function AdminOpponentGamesPage(props: { params: Promise<{ userId: string; pulseId: string }> }) { return <Suspense fallback={<LoadingRows rows={8} />}><OpponentGamesBody {...props} /></Suspense>; }
