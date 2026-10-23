"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Toggle } from "@/components/ui/Toggle";
import { ReviewerBadges } from "./ReviewerBadges";
import { useReviewerPrefs } from "./useReviewerPrefs";

export function MyReviewerProfile() {
  const { me, busy, saveError, toggle } = useReviewerPrefs();
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      if (window.location.hash !== "#reviewer-profile") return;
      frame = requestAnimationFrame(() => {
        if (window.location.hash !== "#reviewer-profile") return;
        root.current?.scrollIntoView({ block: "start" }); root.current?.focus({ preventScroll: true });
      });
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", reveal); };
  }, []);
  const profile = me.data;
  const synced = Math.max(0, profile?.syncedGames ?? 0), required = Math.max(1, profile?.requiredGames ?? 20);
  return <section id="reviewer-profile" ref={root} tabIndex={-1} aria-label="Your reviewer profile" className="scroll-mt-24 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <Card title="Your reviewer profile">
      {me.error ? <RequestError error={me.error} onRetry={() => me.mutate()} /> : null}
      {!profile ? !me.error ? <div aria-label="Loading reviewer profile" aria-busy="true" className="h-48 animate-pulse rounded-lg bg-bg-elevated" /> : null : <div className="space-y-4">
        <p className="break-words font-display text-h4 font-semibold text-text">{profile.name}</p>
        <ReviewerBadges author={{ label: profile.name, isAsker: false, profileHref: null, verified: profile.verified, badges: profile.badges, flair: profile.flair }} />
        {!profile.verified ? <p className="text-caption text-text-muted"><strong>Not verified yet.</strong>{" "}
          {profile.verificationReason === "not_enough_ladder_games" ? "Not enough ranked 1v1 games with recorded MMR in the current or previous season. " : ""}
          Sync your own ladder games to verify your league.</p> : null}
        <dl className="grid grid-cols-2 gap-2">
          {([['karma', 'Karma'], ['reviews', 'Reviews'], ['helpful', 'Helpful'], ['best', 'Best'], ['upvotes', 'Upvotes']] as const).map(([key, label]) => <div key={key} className="min-w-0 rounded-lg border border-border p-2">
            <dt className="text-caption text-text-muted">{label}</dt><dd className="break-words font-mono text-h4 font-bold tabular-nums text-text">{profile.stats[key].toLocaleString()}</dd>
          </div>)}
        </dl>
        <div className="space-y-2">
          <p id="reviewer-eligibility" className="text-caption text-text">{synced} / {required} synced games</p>
          <div role="progressbar" aria-labelledby="reviewer-eligibility" aria-valuemin={0} aria-valuemax={required} aria-valuenow={Math.min(synced, required)} className="h-2 overflow-hidden rounded-full bg-bg-elevated">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, synced / required * 100)}%` }} />
          </div>
          {synced < required ? <Link href="/download" className="inline-flex min-h-11 items-center text-caption font-semibold text-link underline">Get the desktop app</Link> : <p className="text-caption text-text-muted">You meet the synced-game requirement for commenting. Requests can ask for a higher verified league.</p>}
        </div>
        <div className="space-y-3 border-t border-border pt-3">
          <label className="flex min-h-11 items-center justify-between gap-3 text-caption text-text"><span>Show my name on the weekly leaderboard</span><Toggle label="Show my name on the weekly leaderboard" checked={profile.leaderboardOptIn} disabled={busy} onChange={(value) => { void toggle("leaderboardOptIn", value); }} /></label>
          <label className="flex min-h-11 items-center justify-between gap-3 text-caption text-text"><span>Weekly digest of open requests in my matchups</span><Toggle label="Weekly digest of open requests in my matchups" checked={profile.weeklyDigest} disabled={busy} onChange={(value) => { void toggle("weeklyDigest", value); }} /></label>
          {saveError ? <p role="alert" className="text-caption text-danger">{saveError}</p> : null}
        </div>
      </div>}
    </Card>
  </section>;
}
