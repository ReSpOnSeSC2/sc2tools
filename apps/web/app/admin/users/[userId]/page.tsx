"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { apiCall, useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, timeSince } from "../../components/format";
import {
  ConfirmInline,
  ForbiddenCard,
  MetricStat,
} from "../../components/AdminFragments";
import type {
  AdminUserDetail,
  RebuildResp,
  WipeResp,
} from "../../components/adminTypes";

/**
 * /admin/users/[userId] — per-user detail snapshot + targeted
 * actions (rebuild opponents, wipe games).
 *
 * Reuses the same Tools-tab confirmation pattern: destructive
 * action → inline ConfirmInline → API call → result line. No modal.
 */
export default function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  const { data, error, isLoading, mutate } = useApi<AdminUserDetail>(
    `/v1/admin/users/${encodeURIComponent(userId)}`,
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 animate-pulse rounded bg-bg-elevated" />
        <div className="h-32 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="h-64 animate-pulse rounded-xl bg-bg-elevated" />
      </div>
    );
  }
  if (error) {
    if (error.status === 403) return <ForbiddenCard />;
    return (
      <Card padded>
        <p className="text-danger">
          Failed to load user: {error.message}
        </p>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/users"
          className="text-caption text-text-dim hover:text-text"
        >
          ← All users
        </Link>
        <h1 className="break-all text-3xl font-bold">{data.userId}</h1>
        {data.clerkUserId ? (
          <p className="font-mono text-caption text-text-dim">
            clerk: {data.clerkUserId}
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricStat
          label="Games"
          value={compactNumber(data.games.total)}
          caption={`${data.games.wins} W · ${data.games.losses} L`}
        />
        <MetricStat
          label="Opponents"
          value={compactNumber(data.opponents.total)}
        />
        <MetricStat
          label="Last activity"
          value={timeSince(data.games.lastActivity)}
          caption={
            data.games.lastActivity
              ? new Date(data.games.lastActivity).toLocaleDateString()
              : ""
          }
        />
        <MetricStat
          label="Account age"
          value={timeSince(data.createdAt)}
          caption={
            data.createdAt
              ? new Date(data.createdAt).toLocaleDateString()
              : ""
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RebuildOpponentsAction
          userId={data.userId}
          onDone={() => mutate()}
        />
        <WipeGamesAction
          userId={data.userId}
          onDone={() => mutate()}
        />
      </div>

      <Card padded={false}>
        <Card.Header>
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Top opponents
          </h3>
          <span className="text-caption text-text-dim">
            top 5 by gameCount
          </span>
        </Card.Header>
        {data.opponents.top.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted">
            No opponents recorded yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated/40 text-left text-caption uppercase tracking-wider text-text-dim">
              <tr>
                <th className="px-4 py-3 font-semibold">Opponent</th>
                <th className="px-4 py-3 font-semibold">Race</th>
                <th className="px-4 py-3 text-right font-semibold">Games</th>
                <th className="px-4 py-3 text-right font-semibold">W–L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.opponents.top.map((o) => (
                <tr key={o.pulseId} className="hover:bg-bg-elevated/30">
                  <td className="px-4 py-2">
                    <div className="text-text">
                      {o.displayNameSample || "—"}
                    </div>
                    <div className="font-mono text-caption text-text-dim">
                      {o.pulseId}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-text-muted">{o.race || "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {o.gameCount}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className="text-success">{o.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{o.losses}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function RebuildOpponentsAction({
  userId,
  onDone,
}: {
  userId: string;
  onDone: () => void;
}) {
  const { getToken } = useAuth();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "confirm" }
    | { kind: "busy" }
    | { kind: "done"; resp: RebuildResp }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function run() {
    setState({ kind: "busy" });
    try {
      const resp = await apiCall<RebuildResp>(
        getToken,
        `/v1/admin/users/${encodeURIComponent(userId)}/rebuild-opponents`,
        { method: "POST" },
      );
      setState({ kind: "done", resp });
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  return (
    <Card padded>
      <h2 className="text-body font-semibold text-text">
        Rebuild opponents
      </h2>
      <p className="mt-1 text-caption text-text-muted">
        Re-derives every <code>opponents</code> row for this user
        from their <code>games</code>. Use after a buggy re-sync.
      </p>
      {state.kind === "idle" ? (
        <button
          type="button"
          className="mt-3 btn bg-accent text-white hover:bg-accent/90"
          onClick={() => setState({ kind: "confirm" })}
        >
          Rebuild
        </button>
      ) : null}
      {state.kind === "confirm" ? (
        <div className="mt-3">
          <ConfirmInline
            prompt="Rebuild every opponent row for this user?"
            confirmLabel="Rebuild"
            variant="primary"
            onConfirm={run}
            onCancel={() => setState({ kind: "idle" })}
          />
        </div>
      ) : null}
      {state.kind === "busy" ? (
        <p className="mt-3 text-caption text-text-muted">Rebuilding…</p>
      ) : null}
      {state.kind === "done" ? (
        <p className="mt-3 text-caption text-success">
          Rebuilt — dropped {state.resp.droppedRows} rows.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="mt-3 text-caption text-danger">
          Failed: {state.message}
        </p>
      ) : null}
    </Card>
  );
}

function WipeGamesAction({
  userId,
  onDone,
}: {
  userId: string;
  onDone: () => void;
}) {
  const { getToken } = useAuth();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "confirm" }
    | { kind: "busy" }
    | { kind: "done"; resp: WipeResp }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function run() {
    setState({ kind: "busy" });
    try {
      const resp = await apiCall<WipeResp>(
        getToken,
        `/v1/admin/users/${encodeURIComponent(userId)}/wipe-games`,
        { method: "POST" },
      );
      setState({ kind: "done", resp });
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  return (
    <Card padded>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-body font-semibold text-text">
          Wipe all games
        </h2>
        <span className="rounded-full bg-danger/15 px-2 py-0.5 text-caption font-semibold text-danger">
          destructive
        </span>
      </div>
      <p className="mt-1 text-caption text-text-muted">
        Deletes every <code>games</code>, <code>game_details</code>,
        and <code>opponents</code> row for this user. Account and
        custom builds are preserved.
      </p>
      {state.kind === "idle" ? (
        <button
          type="button"
          className="mt-3 btn btn-danger"
          onClick={() => setState({ kind: "confirm" })}
        >
          Wipe games
        </button>
      ) : null}
      {state.kind === "confirm" ? (
        <div className="mt-3">
          <ConfirmInline
            prompt={`Permanently delete every replay-derived row for ${userId}? This can NOT be undone.`}
            confirmLabel="Wipe permanently"
            variant="danger"
            onConfirm={run}
            onCancel={() => setState({ kind: "idle" })}
          />
        </div>
      ) : null}
      {state.kind === "busy" ? (
        <p className="mt-3 text-caption text-text-muted">Wiping…</p>
      ) : null}
      {state.kind === "done" ? (
        <p className="mt-3 text-caption text-success">
          Wiped {state.resp.games} games, {state.resp.opponents} opponents.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="mt-3 text-caption text-danger">
          Failed: {state.message}
        </p>
      ) : null}
    </Card>
  );
}
