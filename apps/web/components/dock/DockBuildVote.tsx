"use client";

/**
 * DockBuildVote — "Chat picks the build": tap up to 3 of your saved
 * builds (real win-rates shown from your replay history), start the
 * vote, and chat decides with !1/!2/!3 through the existing poll
 * widget. Reuses the whole poll pipeline — this panel only assembles
 * the poll (question, options = build names, meta.winRates) and
 * hands it to the same studio POST the Poll panel uses.
 */

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { DockButton } from "./DockClient";
import type { StudioPoll } from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
import { usePollTally } from "./usePollTally";
import type { DockPost } from "./dockActions";
import { DockActionNotice, DockSnapshotState, useDockPanelActions } from "./useDockPanelActions";

interface SlimBuild {
  slug: string;
  name: string;
  race?: string;
  vsRace?: string;
  total: number;
  winRate: number | null;
}

export function DockBuildVote({
  token,
  busy,
  pollActive,
  ready = true,
  poll = null,
  messages = [],
  onPost,
}: {
  token: string;
  busy: boolean;
  /** True while any poll is running — one poll at a time. */
  pollActive: boolean;
  ready?: boolean;
  poll?: StudioPoll | null;
  messages?: ReadonlyArray<ChatMessage>;
  onPost: DockPost;
}) {
  const tally = usePollTally(messages, poll);
  const [builds, setBuilds] = useState<SlimBuild[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [matchup, setMatchup] = useState("All");

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(false);
    void (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/builds`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error("builds unavailable");
        if (cancelled) return;
        const body = (await res.json()) as { builds?: SlimBuild[] };
        if (!cancelled) setBuilds(Array.isArray(body.builds) ? body.builds.slice(0, 50) : []);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const toggle = (slug: string) =>
    setPicked((prev) =>
      prev.includes(slug)
        ? prev.filter((s) => s !== slug)
        : prev.length >= 3
          ? prev
          : [...prev, slug],
    );

  const { run, pending, notice } = useDockPanelActions(ready, busy, onPost, {
    start: () => {
      const chosen = picked.map((slug) => builds.find((b) => b.slug === slug)).filter((b): b is SlimBuild => Boolean(b));
      if (pollActive || chosen.length < 2) return null;
      const winRates: Record<string, number> = {};
      for (const b of chosen) if (b.winRate !== null) winRates[b.name] = Math.round(b.winRate * 100);
      return { patch: { poll: { question: "Chat picks the build!", options: chosen.map((b) => b.name), status: "open", meta: { kind: "build", winRates } } }, message: "Build vote started", after: () => setPicked([]) };
    },
  });
  if (!ready) return <DockSnapshotState />;
  if (error) return <p role="alert" className="text-caption text-text-muted">Couldn&apos;t load your builds · <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>Retry</button></p>;
  if (!loaded) return <p role="status" className="text-caption text-text-muted">Loading your builds…</p>;
  if (pollActive) {
    if (poll?.status !== "closed" || poll.meta?.kind !== "build") return null;
    const { counts, total } = tally!;
    if (!total) return <p className="text-caption text-text-muted">No votes cast.</p>;
    const highest = Math.max(...counts);
    const leaders = poll.options.filter((_, index) => counts[index] === highest);
    if (leaders.length > 1) return <p className="text-caption text-text">Vote tied: {leaders.join(", ")}</p>;
    const name = leaders[0];
    const winner = builds.find((build) => build.name === name);
    return <p className="text-caption text-text">Winner: <b>{name}</b>{winner ? <> · <a href={`/builds/${encodeURIComponent(winner.slug)}`} target="_blank" rel="noopener noreferrer" className="underline">Open build<span className="sr-only"> (opens in new tab)</span></a></> : null}</p>;
  }
  const matchupOf = (build: SlimBuild) => build.race && build.vsRace ? `${build.race}v${build.vsRace}` : null;
  const matchups = ["All", ...new Set(builds.map(matchupOf).filter((m): m is string => Boolean(m)))];
  const shown = builds.filter((build) => matchup === "All" || matchupOf(build) === matchup);

  if (loaded && builds.length === 0) {
    return (
      <p className="text-caption text-text-dim">
        No saved builds yet — create one in <a href="/builds" target="_blank" rel="noopener noreferrer" className="underline">Builds</a>.
      </p>
    );
  }

  return (
    <fieldset disabled={busy || pending} className="min-w-0"><div className="space-y-2">
      <DockActionNotice message={notice} />
      <div role="group" aria-label="Build matchups" className="flex flex-wrap gap-1">{matchups.map((m) => <button key={m} type="button" aria-pressed={matchup === m} onClick={() => setMatchup(m)} className={`rounded border px-2 py-1 text-caption ${matchup === m ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted"}`}>{m}</button>)}</div>
      <p className="text-caption text-text-dim">
        Pick 2–3 builds; chat votes with <b>!1</b>/<b>!2</b>/<b>!3</b> on
        the Chat poll widget.
      </p>
      <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
        {shown.map((b) => {
          const on = picked.includes(b.slug);
          return (
            <li key={b.slug}>
              <button
                type="button"
                onClick={() => toggle(b.slug)}
                aria-pressed={on}
                disabled={!on && picked.length >= 3}
                className={`flex w-full min-w-0 items-baseline gap-2 rounded-md border px-2 py-1 text-left text-caption ${
                  on
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border bg-bg-elevated text-text-muted hover:text-text"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {b.name}
                </span>
                {b.race ? (
                  <span className="text-micro text-text-dim">
                    {b.race}v{b.vsRace ?? "X"}
                  </span>
                ) : null}
                <span className="text-micro tabular-nums text-text-dim">
                  {b.winRate !== null
                    ? `${Math.round(b.winRate * 100)}% · ${b.total}g`
                    : "no games"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <DockButton
          disabled={busy || picked.length < 2 || pollActive}
          onClick={() => void run("start")}
        >
          Start build vote
        </DockButton>
        {pollActive ? (
          <span className="text-micro text-text-dim">
            Close the running poll first
          </span>
        ) : null}
      </div>
    </div></fieldset>
  );
}
