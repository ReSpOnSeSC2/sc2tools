"use client";
import { useState } from "react";
import Link from "next/link";
import { History } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { AssignedReplayDownload } from "./AssignedReplayDownload";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import {
  digestPlayedLabel,
  digestRecord,
  digestWindowLabel,
  parsePrepDigest,
  type PrepDigest,
  type PrepDigestFacts,
  type PrepDigestRole,
} from "./coachingPrepDigest";

/**
 * "Since last session" on one upcoming booking. It loads when opened, so a
 * long session list never reads every student's games at once.
 */
export function SessionPrepDigest({ bookingId, viewerRole, timeZone, studentName, defaultOpen = false, active = true }: {
  bookingId: string;
  viewerRole: PrepDigestRole;
  timeZone: string;
  studentName?: string;
  defaultOpen?: boolean;
  active?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const digest = useApi<unknown>(
    active && open ? `/v1/coaching/calendar/bookings/${encodeURIComponent(bookingId)}/digest` : null,
    { revalidateOnFocus: true },
  );
  const parsed = active && open ? parsePrepDigest(digest.data) : null;
  const data = parsed?.bookingId === bookingId && parsed.role === viewerRole && !digest.error ? parsed : null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mt-3 rounded-lg border border-border bg-bg-surface/70"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-caption font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="inline-flex items-center gap-2"><History className="h-4 w-4 text-accent-cyan" aria-hidden />Since last session</span>
        {data && data.state !== "sharing_off" ? (
          <span className="font-mono text-micro tabular-nums text-text-muted">
            {data.totals.games} game{data.totals.games === 1 ? "" : "s"}
          </span>
        ) : null}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {!active || !open ? null : data ? (
          <PrepDigestView digest={data} timeZone={timeZone} studentName={studentName} />
        ) : digest.error ? (
          <div role="alert" className="space-y-2 text-caption text-text-muted">
            <p>The prep digest could not load.</p>
            <Button size="sm" variant="secondary" onClick={() => void digest.mutate()}>Retry</Button>
          </div>
        ) : (
          <p aria-busy="true" className="text-caption text-text-dim">Loading the prep digest…</p>
        )}
      </div>
    </details>
  );
}

export function PrepDigestView({ digest, timeZone, studentName }: { digest: PrepDigest; timeZone: string; studentName?: string }) {
  if (digest.state === "sharing_off") {
    return (
      <p className="text-caption text-text-muted">
        {digest.role === "coach"
          ? `${studentName || "This student"} hasn't allowed practice sharing, so their games stay private. Request approval on the Practice tab.`
          : "Practice sharing is off, so your games stay private. Allow practice sharing on the Practice tab to share them with your coach."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-caption text-text-muted">
        {digestWindowLabel(digest, timeZone)} · {digest.totals.games} {digest.role === "coach" ? "ranked" : "eligible"} 1v1 game{digest.totals.games === 1 ? "" : "s"}
        {digest.totals.games ? ` · ${digest.totals.wins}–${digest.totals.losses}` : ""}
      </p>
      {digest.state === "no_games" ? null : <DigestFacts digest={digest} timeZone={timeZone} />}
      <p className="flex flex-wrap items-center gap-x-3 text-micro text-text-dim">
        <span>Facts from synced replays only. No grades or scores.</span>
        <LazyHelpLink slug="coaching" anchor="session-prep-digest" className="inline-flex min-h-10 items-center font-semibold">
          How the prep digest works
        </LazyHelpLink>
      </p>
    </div>
  );
}

function DigestFacts({ digest, timeZone }: { digest: PrepDigestFacts; timeZone: string }) {
  return (
    <>
      {digest.matchups.length ? (
        <section aria-label="Record by matchup">
          <h4 className="text-micro font-bold uppercase tracking-wider text-text-dim">By matchup</h4>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {digest.matchups.map((row) => (
              <li key={row.matchup} className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 font-mono text-caption tabular-nums text-text">
                {row.matchup} · {row.games} · {digestRecord(row.wins, row.losses, row.winRate)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-micro text-text-dim">Win rates appear once a matchup has {digest.minSample} decided games.</p>
        </section>
      ) : null}
      {digest.builds.length || digest.unclassifiedGames ? (
        <section aria-label="Builds played">
          <h4 className="text-micro font-bold uppercase tracking-wider text-text-dim">Builds played{digest.role === "coach" ? " in assigned games" : ""}</h4>
          <ul className="mt-1 flex flex-wrap gap-1.5 text-caption">
            {digest.builds.map((build) => <li key={build.name} className="rounded-full border border-border px-2.5 py-1 text-text">{build.name} · {build.games}</li>)}
            {digest.unclassifiedGames ? <li className="rounded-full border border-dashed border-border px-2.5 py-1 text-text-muted">Not classified · {digest.unclassifiedGames}</li> : null}
            {digest.moreBuilds ? <li className="px-1 py-1 text-text-dim">+{digest.moreBuilds} more</li> : null}
          </ul>
        </section>
      ) : null}
      {digest.replays.length ? <section aria-label="New replays">
        <h4 className="text-micro font-bold uppercase tracking-wider text-text-dim">{digest.role === "coach" ? "New assigned replays" : "New replays"}</h4>
        <ul className="mt-1 space-y-1.5">
          {digest.replays.map((game, index) => <DigestReplay key={game.gameId ?? game.evidenceRef ?? `${game.playedAt}:${index}`} bookingId={digest.bookingId} game={game} role={digest.role} timeZone={timeZone} />)}
        </ul>
        {digest.moreReplays ? <p className="mt-1 text-micro text-text-dim">+{digest.moreReplays} older game{digest.moreReplays === 1 ? "" : "s"} in this window.</p> : null}
        {digest.role === "coach" ? <Link href="/coaching?view=practice" className="inline-flex min-h-11 items-center text-caption text-link underline">Find assigned replays in Practice</Link> : null}
      </section> : null}
    </>
  );
}

function DigestReplay({ bookingId, game, role, timeZone }: { bookingId: string; game: PrepDigestFacts["replays"][number]; role: PrepDigestRole; timeZone: string }) {
  const label = [game.map || "Unknown map", game.matchup, game.build].filter(Boolean).join(" · ");
  const badge = game.result === "Win" ? "border-success/35 bg-success/10 text-success" : game.result === "Loss" ? "border-danger/35 bg-danger/10 text-danger" : "border-border text-text-dim";
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-elevated/35 px-2.5 py-1.5 text-caption">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border font-mono text-micro font-extrabold ${badge}`}>
        <span aria-hidden>{game.result === "Win" ? "W" : game.result === "Loss" ? "L" : "—"}</span>
        <span className="sr-only">{game.result ?? "No result"}</span>
      </span>
      <span className="min-w-0 flex-1 break-words text-text">{label}</span>
      <span className="font-mono text-micro tabular-nums text-text-dim">{digestPlayedLabel(game.playedAt, timeZone)}</span>
      {role === "student" && game.gameId ? (
        <Link href={`/app/game/${encodeURIComponent(game.gameId)}`} aria-label={`Open game: ${label}`} className="inline-flex min-h-10 items-center font-semibold text-link hover:underline">
          Open game
        </Link>
      ) : null}
      {role === "coach" && game.evidenceRef ? <AssignedReplayDownload bookingId={bookingId} reference={game.evidenceRef} label={label} /> : null}
    </li>
  );
}
