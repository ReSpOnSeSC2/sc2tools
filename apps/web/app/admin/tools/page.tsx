"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { apiCall } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { ConfirmInline } from "../components/AdminFragments";
import { formatRebuildSummary } from "../components/format";
import type { RebuildResp, WipeResp } from "../components/adminTypes";

/**
 * /admin/tools — operational tools.
 *
 * The two tools here address concrete failure modes the admin will
 * realistically hit:
 *
 *   1. "Fix my counters" — re-derives the calling admin's own
 *      ``opponents`` rows from ``games``. Used after a buggy
 *      re-sync inflates per-opponent gameCount/wins/losses.
 *
 *   2. "Rebuild opponents for user…" — same operation scoped to
 *      another userId. Used when supporting another user who hits
 *      the same problem.
 *
 *   3. "Wipe all games for user…" — admin-side GDPR purge. Cascades
 *      through ``GdprService.wipeGames`` so games + game_details +
 *      opponents are all dropped.
 *
 * Each destructive action requires a confirmation step before
 * firing — no modal, just an inline prompt that replaces the button
 * row until the admin confirms or cancels.
 */
export default function AdminToolsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Tools</h1>
        <p className="text-text-muted">
          Operational utilities for repairing data integrity issues
          and supporting individual users. All actions are logged
          server-side.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <RebuildMyOpponentsTool />
        <RebuildUserOpponentsTool />
      </div>

      <WipeUserGamesTool />
    </div>
  );
}

/**
 * One-click "Fix my counters" — bypasses the userId text field
 * because the most common case is the admin recovering their own
 * data after a buggy re-sync.
 */
function RebuildMyOpponentsTool() {
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
        "/v1/admin/me/rebuild-opponents",
        { method: "POST" },
      );
      setState({ kind: "done", resp });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  return (
    <Card padded>
      <h2 className="text-body font-semibold text-text">
        Fix my counters
      </h2>
      <p className="mt-1 text-caption text-text-muted">
        Drops every <code>opponents</code> row tied to your own
        account, then re-derives them from your <code>games</code>.
        Use this if the per-opponent <code>gameCount</code> /{" "}
        <code>wins</code> / <code>losses</code> on your dashboard
        looks inflated after a re-sync.
      </p>
      {state.kind === "idle" ? (
        <button
          type="button"
          className="mt-3 btn bg-accent text-white hover:bg-accent/90"
          onClick={() => setState({ kind: "confirm" })}
        >
          Rebuild my opponents
        </button>
      ) : null}
      {state.kind === "confirm" ? (
        <div className="mt-3">
          <ConfirmInline
            prompt="Rebuild every opponent row for your own account?"
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
        <ResultLine
          tone="success"
          message={formatRebuildSummary(state.resp)}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
      {state.kind === "error" ? (
        <ResultLine
          tone="danger"
          message={`Rebuild failed: ${state.message}`}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
    </Card>
  );
}

/**
 * Targeted rebuild — same operation as above but for an arbitrary
 * userId. The admin pastes a userId from the Users tab into the
 * input. Userid is internal to the app (not Clerk userId) so we
 * don't have to round-trip Clerk to resolve.
 */
function RebuildUserOpponentsTool() {
  const { getToken } = useAuth();
  const [userId, setUserId] = useState("");
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
        `/v1/admin/users/${encodeURIComponent(userId.trim())}/rebuild-opponents`,
        { method: "POST" },
      );
      setState({ kind: "done", resp });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  const canRun = userId.trim().length > 0;

  return (
    <Card padded>
      <h2 className="text-body font-semibold text-text">
        Rebuild opponents for user…
      </h2>
      <p className="mt-1 text-caption text-text-muted">
        Same as &ldquo;Fix my counters&rdquo;, but for any userId.
        Useful when a user reports inflated numbers and you have
        their userId from the Users tab.
      </p>
      <input
        type="text"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder="e.g. u_abc123"
        className="mt-3 w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        disabled={state.kind === "busy"}
      />
      {state.kind === "idle" ? (
        <button
          type="button"
          className="mt-3 btn bg-accent text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setState({ kind: "confirm" })}
          disabled={!canRun}
        >
          Rebuild opponents
        </button>
      ) : null}
      {state.kind === "confirm" ? (
        <div className="mt-3">
          <ConfirmInline
            prompt={`Rebuild every opponent row for ${userId.trim()}?`}
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
        <ResultLine
          tone="success"
          message={formatRebuildSummary(state.resp)}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
      {state.kind === "error" ? (
        <ResultLine
          tone="danger"
          message={`Rebuild failed: ${state.message}`}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
    </Card>
  );
}

/**
 * Destructive: delete every game (and detail row, and opponent) for
 * a user. Routes through GdprService.wipeGames so the cascade is
 * identical to the user's own GDPR purge — no risk of an admin
 * delete leaving orphaned details behind.
 */
function WipeUserGamesTool() {
  const { getToken } = useAuth();
  const [userId, setUserId] = useState("");
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
        `/v1/admin/users/${encodeURIComponent(userId.trim())}/wipe-games`,
        { method: "POST" },
      );
      setState({ kind: "done", resp });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  const canRun = userId.trim().length > 0;

  return (
    <Card padded>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-body font-semibold text-text">
          Wipe all games for user…
        </h2>
        <span className="rounded-full bg-danger/15 px-2 py-0.5 text-caption font-semibold text-danger">
          destructive
        </span>
      </div>
      <p className="mt-1 text-caption text-text-muted">
        Removes every <code>games</code>, <code>game_details</code>,
        and <code>opponents</code> row for the user. Cascades through{" "}
        <code>GdprService.wipeGames</code>. The user&apos;s account
        and custom builds are preserved — only replay-derived data
        is removed.
      </p>
      <input
        type="text"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder="e.g. u_abc123"
        className="mt-3 w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-danger focus:outline-none"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        disabled={state.kind === "busy"}
      />
      {state.kind === "idle" ? (
        <button
          type="button"
          className="mt-3 btn btn-danger disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setState({ kind: "confirm" })}
          disabled={!canRun}
        >
          Wipe games
        </button>
      ) : null}
      {state.kind === "confirm" ? (
        <div className="mt-3">
          <ConfirmInline
            prompt={`Permanently delete every replay-derived row for ${userId.trim()}? This can NOT be undone.`}
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
        <ResultLine
          tone="success"
          message={`Wiped ${state.resp.games} games, ${state.resp.opponents} opponents, ${state.resp.macroJobs} macro jobs.`}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
      {state.kind === "error" ? (
        <ResultLine
          tone="danger"
          message={`Wipe failed: ${state.message}`}
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
    </Card>
  );
}

function ResultLine({
  tone,
  message,
  onDismiss,
}: {
  tone: "success" | "danger";
  message: string;
  onDismiss: () => void;
}) {
  const colour =
    tone === "success" ? "text-success" : "text-danger";
  return (
    <div className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-border bg-bg-elevated/40 p-3">
      <p className={`flex-1 text-caption ${colour}`}>{message}</p>
      <button
        type="button"
        className="text-caption text-text-dim hover:text-text"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
