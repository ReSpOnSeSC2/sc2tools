"use client";
import { useEffect, useState, type ReactNode } from "react";
import { fmtAgo, pct1 } from "@/lib/format";
import type { RivalSummary } from "@/lib/useRivalSummary";
import type { OpponentGroup } from "@/lib/opponentGroups";
import { PlayerChannelLinks } from "../PlayerChannelLinks";
import type { usePlayerChannels } from "../usePlayerChannels";
import { OpponentLink } from "./OpponentTableRows";
import { OpponentRace } from "./OpponentRace";
import type { Opp, OpenOpponent } from "./types";

export function StarredRivalCards({ rows, summary, keyFor, onOpen, star, channelsFor, totalStars }: {
  rows: OpponentGroup<Opp>[]; summary?: RivalSummary; keyFor: (row: OpponentGroup<Opp>) => string | undefined;
  onOpen: OpenOpponent; star: (row: OpponentGroup<Opp>) => ReactNode; channelsFor: ReturnType<typeof usePlayerChannels>; totalStars: number;
}) {
  const byKey = new Map(summary?.rivals.map(item => [item.key, item]));
  return <section aria-label="Starred rivals"><p className="mb-3 text-caption text-text-dim">Your stars stay saved across filters. Streak and usual opener use at most 20 recent matching meetings, across up to 500 recorded accounts per batch. Pulse movement is an account snapshot cached for 6 hours; missing observations stay unknown.</p>
    {!totalStars ? <p className="rounded-xl border border-line p-5 text-text-muted">Star an opponent to keep them here.</p> : null}
    {totalStars > rows.length ? <p className="mb-2 text-caption text-text-muted">Some saved rivals have no matching row in this view. Widen your filters or search to find them.</p> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(row => {
      const meta = byKey.get(keyFor(row) || "");
      return <article key={row.pulseId} className="min-w-0 rounded-xl border-2 border-line bg-bg-surface p-4"><div className="flex items-center gap-2"><OpponentLink opponent={row} onOpen={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 font-semibold"><span className="truncate">{row.name || "unnamed"}</span><OpponentRace row={row} /></OpponentLink>{star(row)}</div>
        <p className="text-sm tabular-nums">{row.wins}–{row.losses} · {pct1(row.winRate)} · {row.games} games</p>
        <p className="mt-2 text-caption text-text-muted">{meta?.streak ? `${meta.streak.count}${meta.streak.atLeast ? "+" : ""} ${meta.streak.kind === "win" ? "wins" : "losses"} in a row` : "Streak unmeasured"}</p>
        <p className="text-caption text-text-muted">Last meeting {row.lastPlayed ? <time dateTime={row.lastPlayed} title={new Date(row.lastPlayed).toLocaleString()}>{fmtAgo(row.lastPlayed)}</time> : "unknown"}</p>
        <p className="mt-2 break-words text-caption"><span className="text-text-dim">Usual opener: </span>{meta?.usualOpener ? `${meta.usualOpener.name} (${meta.usualOpener.samples}/${meta.usualOpener.of} recent meetings)` : "Not enough labelled meetings"}</p>
        <p className="mt-2 text-caption" title={meta?.pulse?.change ? `${meta.pulse.change.baselineAt} → ${meta.pulse.change.currentAt}; fetched ${meta.pulse.fetchedAt || "unknown"}` : undefined}>Pulse 30-day MMR: {meta?.pulse?.change ? `${meta.pulse.change.delta > 0 ? "+" : ""}${meta.pulse.change.delta}` : "Unknown"}</p>
        {meta?.pulse?.fetchedAt ? <p className="text-micro text-text-dim">Account {row.pulseCharacterId || row.pulseId} · cached {fmtAgo(meta.pulse.fetchedAt)}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2"><PlayerChannelLinks channels={channelsFor(row)} playerName={row.name} compact /><CachedLiveBadge observations={meta?.live || []} /></div>
        <p className="mt-2 text-micro text-text-dim">Live status uses fresh public cache observations only; no badge means unknown or offline.</p>
      </article>;
    })}</div>
  </section>;
}
function CachedLiveBadge({ observations }: { observations: RivalSummary["rivals"][number]["live"] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const current = Date.now(); setNow(current);
    const expirations = observations.map(item => Date.parse(item.observedAt) + 20000 - current).filter(delay => delay > 0);
    if (!expirations.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(...expirations) + 1);
    return () => clearTimeout(timer);
  }, [observations]);
  const live = observations.find(item => Date.parse(item.observedAt) <= now && now - Date.parse(item.observedAt) < 20000);
  return live ? <a href={live.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded border border-success/40 px-2 text-caption text-success" title={`Public ${live.platform} observation at ${new Date(live.observedAt).toLocaleTimeString()}`}>Live now</a> : null;
}
