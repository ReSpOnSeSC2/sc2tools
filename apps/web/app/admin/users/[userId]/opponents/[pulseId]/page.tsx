"use client";

import { use, useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { OpponentDiagnosticsPanel } from "@/components/analyzer/OpponentDiagnosticsPanel";
import { ForbiddenCard, LoadingRows } from "../../../../components/AdminFragments";
import {
  AdminGameDetail,
  fmtDate,
  fmtDuration,
  isWin,
} from "../../../../components/AdminGameDetail";
import type {
  AdminGameVsOpponentRow,
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
export default function AdminOpponentGamesPage({
  params,
}: {
  params: Promise<{ userId: string; pulseId: string }>;
}) {
  const { userId, pulseId } = use(params);

  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<AdminGameVsOpponentRow | null>(null);

  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  const path = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/opponents/${encodeURIComponent(pulseId)}/games?${query.toString()}`;

  const { data, error, isLoading } = useApi<OpponentGamesResp>(path);

  function nextPage() {
    if (data?.nextBefore) {
      setPageHistory((h) => [...h, data.nextBefore]);
      setBefore(data.nextBefore);
      setSelected(null);
    }
  }
  function prevPage() {
    if (pageHistory.length <= 1) return;
    const popped = pageHistory.slice(0, -1);
    setPageHistory(popped);
    setBefore(popped[popped.length - 1] ?? null);
    setSelected(null);
  }

  if (error && error.status === 403) return <ForbiddenCard />;

  const oppName = data?.items[0]?.opponent.displayName || "";

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/users/${encodeURIComponent(userId)}/opponents`}
          className="text-caption text-text-dim hover:text-text"
        >
          ← All opponents
        </Link>
        <h1 className="text-3xl font-bold">{oppName || "Opponent"}</h1>
        <p className="break-all font-mono text-caption text-text-dim">
          {pulseId}
        </p>
        <p className="text-text-muted">
          Every game this user played against this opponent. Click a game
          to see both build orders, just like the user&apos;s own replay.
        </p>
      </header>

      <OpponentDiagnosticsPanel
        diagnosticsPath={`/v1/admin/users/${encodeURIComponent(
          userId,
        )}/opponents/${encodeURIComponent(pulseId)}/diagnostics`}
        retryPath={`/v1/admin/users/${encodeURIComponent(
          userId,
        )}/opponents/${encodeURIComponent(pulseId)}/retry-pulse`}
      />

      {isLoading ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">Failed to load games: {error.message}</p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            No games recorded against this opponent.
          </p>
        </Card>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-4">
          {/* Games list — hidden on mobile once a game is selected. */}
          <div className={selected ? "hidden lg:block" : "block"}>
            <Card padded={false}>
              <ul className="divide-y divide-border">
                {data.items.map((g) => {
                  const active = selected?.gameId === g.gameId;
                  return (
                    <li key={g.gameId}>
                      <button
                        type="button"
                        onClick={() => setSelected(g)}
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

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pageHistory.length <= 1}
                onClick={prevPage}
              >
                ← Previous
              </button>
              <span className="text-caption text-text-dim">
                {data.items.length} on this page
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!data.nextBefore}
                onClick={nextPage}
              >
                Next →
              </button>
            </div>
          </div>

          {/* Detail — hidden on mobile until a game is selected. */}
          <div className={selected ? "block" : "hidden lg:block"}>
            {selected ? (
              <AdminGameDetail
                userId={userId}
                game={selected}
                onBack={() => setSelected(null)}
              />
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
