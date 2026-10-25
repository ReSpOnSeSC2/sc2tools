"use client";
import { useState } from "react";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ReplayDownloadButton } from "@/components/analyzer/ReplayDownloadButton";
import { useApi } from "@/lib/clientApi";
import { formatGameDate, requirementTitle, type AssignmentGamesPayload, type PracticeAssignment } from "./coachingPracticeModel";
export function ReplayEvidence({ assignment }: { assignment: PracticeAssignment }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const evidence = useApi<AssignmentGamesPayload>(
    open
      ? `/v1/coaching/assignments/${encodeURIComponent(assignment.id)}/games?page=${page}&limit=25`
      : null,
    {
      revalidateOnFocus: true,
      refreshInterval: open ? 30_000 : 0,
      keepPreviousData: false,
    },
    { timeoutMs: 20_000 },
  );
  const games = evidence.data?.games || [];
  const total = evidence.data?.total ?? assignment.progress.replayGameCount
    ?? assignment.progress.playedGames;
  const totalPages = Math.max(1, Math.ceil(total / (evidence.data?.limit || 25)));
  const assignmentLabel = assignment.requirement.title?.trim() || requirementTitle(assignment);
  return (
    <details
      className="group mt-4 border-t border-border pt-4"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) setPage(1);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-1 text-caption font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent-cyan" aria-hidden />
          Games and replay evidence
        </span>
        <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-0.5 font-mono text-micro tabular-nums text-text-muted">
          {total}
        </span>
      </summary>
      <div className="mt-3 space-y-2">
        {evidence.data && !evidence.error ? <p className="text-caption text-text-muted">{evidence.data.total} games{typeof evidence.data.wins === "number" && typeof evidence.data.losses === "number" ? ` · ${evidence.data.wins}–${evidence.data.losses}${evidence.data.wins + evidence.data.losses > 0 ? ` (${Math.round(100 * evidence.data.wins / (evidence.data.wins + evidence.data.losses))}%)` : ""}` : ""}</p> : null}
        {evidence.isLoading && !evidence.data ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-caption text-text-dim">
            Loading replay evidence…
          </div>
        ) : evidence.error ? (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-5 text-center text-caption text-danger">
            <p>Replay evidence could not load.</p><Button variant="secondary" className="mt-3" onClick={() => void evidence.mutate()}>Retry</Button>
          </div>
        ) : games.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-caption text-text-dim">
            No eligible 1v1 replays have landed in this timeframe yet.
          </div>
        ) : games.map((game) => (
          <div
            key={game.gameId}
            className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated/35 px-3 py-2.5"
          >
            <span className={[
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg border font-mono text-micro font-extrabold",
              /victory|win/i.test(game.result)
                ? "border-success/35 bg-success/10 text-success"
                : /defeat|loss/i.test(game.result)
                  ? "border-danger/35 bg-danger/10 text-danger"
                  : "border-border text-text-dim",
            ].join(" ")}>
              {/victory|win/i.test(game.result) ? "W" : /defeat|loss/i.test(game.result) ? "L" : "—"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-caption font-bold text-text">
                {game.map || "Unknown map"}{game.opponent ? ` · vs ${game.opponent}` : ""}
              </p>
              <p className="truncate text-micro text-text-dim">
                {formatGameDate(game.date, assignment.requirement.timeZone)}
                {game.myBuild ? ` · ${game.myBuild}` : ""}
                {game.isLadderGame === true
                  ? " · Ladder 1v1"
                  : game.isLadderGame === false
                    ? " · Custom 1v1"
                    : " · 1v1"}
              </p>
            </div>
            <ReplayDownloadButton
              gameId={game.gameId}
              available={game.replayAvailable}
              showLabel
              contextLabel={`${game.map || "game"} on ${formatGameDate(game.date, assignment.requirement.timeZone)}`}
              downloadPath={`/v1/coaching/assignments/${encodeURIComponent(assignment.id)}/games/${encodeURIComponent(game.gameId)}/replay-download`}
              unavailableMessage="This student replay is not archived yet. Ask the student to update the desktop agent and run Re-sync."
            />
          </div>
        ))}
        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              aria-label={`Newer games for ${assignmentLabel}`}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Newer
            </Button>
            <span className="text-micro text-text-dim">Page {page} of {totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!evidence.data?.hasMore}
              aria-label={`Older games for ${assignmentLabel}`}
              onClick={() => setPage((value) => value + 1)}
            >
              Older
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

