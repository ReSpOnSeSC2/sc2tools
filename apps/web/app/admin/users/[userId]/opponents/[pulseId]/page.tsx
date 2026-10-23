"use client";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { useAdminQueryState } from "../../../../components/useAdminQueryState";
import { useAdminCursor } from "../../../../components/useAdminCursor";
import { AdminSelectedGame } from "../../../../components/AdminSelectedGame";
import { AdminPagination } from "@/app/admin/components/AdminPagination";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { Suspense, use } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { OpponentDiagnosticsPanel } from "@/components/analyzer/OpponentDiagnosticsPanel";
import { ForbiddenCard, LoadingRows } from "../../../../components/AdminFragments";
import {
  fmtDate,
  fmtDuration,
  isWin,
} from "../../../../components/AdminGameDetail";
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
 * Master/detail: games list on the left, the selected game's build
 * order on the right. On mobile the two swap so only one shows at a
 * time, with a back affordance.
 */
function OpponentGamesBody({
  params,
}: {
  params: Promise<{ userId: string; pulseId: string }>;
}) {
  const { userId, pulseId } = use(params);

  const [view, setView] = useAdminQueryState({ game: "", before: "" });
  const before = view.before;
  const paging = useAdminCursor(before, before => setView({ before }));
  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  const path = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/opponents/${encodeURIComponent(pulseId)}/games?${query.toString()}`;

  const { data, error, isLoading, isValidating, mutate } = useApi<OpponentGamesResp>(path, { keepPreviousData: true });

  const selected = data?.items.find(g => g.gameId === view.game);

  if (error && error.status === 403) return <ForbiddenCard />;

  const oppName = data?.items[0]?.opponent.displayName || "";

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

      {error && data ? <RequestError error={error} onRetry={() => mutate()} /> : null}
      {error && !data ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : (!data || data.items.length === 0) && !view.game ? (
        <Card padded>
          <EmptyStatePanel title="No games recorded against this opponent" action={<Button variant="secondary" onClick={() => void mutate()}>Refresh</Button>} />
        </Card>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-4">
          {/* Games list — hidden on mobile once a game is selected. */}
          <div className={view.game ? "hidden lg:block" : "block"}>
            <Card padded={false}>
              <p role="status" className="text-caption text-text-muted">{data?.items.length || 0} games{data && isValidating ? " · Updating…" : ""}</p>
              <ul aria-busy={isValidating} className={`divide-y divide-border transition-opacity ${isValidating ? "opacity-60" : ""}`}>
                {(data?.items || []).map((g) => {
                  const active = g.gameId === view.game;
                  return (
                    <li key={g.gameId}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => setView({ game: g.gameId })}
                        className={[
                          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                          active
                            ? "bg-accent/10"
                            : "hover:bg-bg-elevated/40",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={[
                              "rounded-full px-2 py-0.5 text-caption font-semibold",
                              isWin(g.result)
                                ? "bg-success/15 text-success"
                                : "bg-danger/15 text-danger",
                            ].join(" ")}
                          >
                            {isWin(g.result) ? "Win" : "Loss"}
                          </span>
                          <span className="text-caption text-text-dim">
                            {fmtDate(g.date)}
                          </span>
                        </div>
                        <div className="text-caption text-text-muted">
                          {(g.myRace || "?")[0]}v{(g.opponent.race || "?")[0]}
                          {" · "}
                          {g.map || "—"}
                          {" · "}
                          {fmtDuration(g.durationSec)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={data?.items.length || 0} />
          </div>

          {/* Detail — hidden on mobile until a game is selected. */}
          <div className={view.game ? "block" : "hidden lg:block"}>
            {view.game ? (
              <AdminSelectedGame userId={userId} gameId={view.game} row={selected} onClear={() => setView({ game: "" })} />
            ) : (
              <Card padded>
                <p className="text-text-muted">
                  Select a game to view its build orders.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminOpponentGamesPage(props: { params: Promise<{ userId: string; pulseId: string }> }) { return <Suspense fallback={<LoadingRows rows={8} />}><OpponentGamesBody {...props} /></Suspense>; }
