"use client";

import { useState } from "react";
import Link from "next/link";
import { SignedIn, useAuth } from "@clerk/nextjs";
import { Trophy } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { apiCall, useApi } from "@/lib/clientApi";
import { usePublicApi } from "@/lib/usePublicApi";
import {
  reviewsRollout,
  verifiedLabel,
  verifiedRegionsLabel,
  type LeaderboardResponse,
  type ReviewBoardResponse,
  type ReviewerMe,
} from "@/lib/reviews";
import { ReviewCard } from "./ReviewCard";
import { Button } from "@/components/ui/Button";

/**
 * "Requests you can help with" — the signed-in reviewer's verified race's
 * matchups at or below their verified band. Personalised, so client-only.
 */
export function HelpWithList({ now }: { now: number }) {
  const { data, error } = useApi<ReviewBoardResponse & { verified: ReviewerMe["verified"]; reason: string | null }>(
    "/v1/reviews/for-me",
    { revalidateOnFocus: false },
  );
  if (error || !data) return null;
  return (
    <section aria-labelledby="help-with-title" className="space-y-2">
      <h2 id="help-with-title" className="font-display text-h4 font-bold text-text">Requests you can help with</h2>
      {data.reason === "unverified" ? (
        <p className="text-caption text-text-muted">
          Play some ranked 1v1 games this season and sync them — we match requests to your verified race and league.
        </p>
      ) : data.items.length === 0 ? (
        <p className="text-caption text-text-muted">Nothing waiting in your matchups right now.</p>
      ) : (
        <>
          <p className="text-caption text-text-muted">{verifiedLabel(data.verified)} and below</p>
          <ul className="space-y-2">{data.items.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}</ul>
        </>
      )}
    </section>
  );
}

/**
 * Weekly reviewer leaderboard. Names appear only for reviewers who opted
 * in; the toggle is here for the signed-in viewer.
 */
export function ReviewLeaderboard({ initial }: { initial: LeaderboardResponse | null }) {
  const board = usePublicApi<LeaderboardResponse>("/v1/reviews/leaderboard", {
    fallbackData: initial ?? undefined,
    revalidateOnFocus: false,
  }, { personalized: reviewsRollout() === "admins" });
  const items = board.data?.items ?? [];
  return (
    <Card title="This week's top reviewers" right={<Trophy className="h-4 w-4 text-warning" aria-hidden />}>
      {items.length === 0 ? (
        <p className="text-caption text-text-muted">No opted-in reviewers have earned karma this week yet.</p>
      ) : (
        <ol className="space-y-1.5">
          {items.map((row) => (
            <li key={row.rank} className="flex items-center gap-2 text-caption">
              <span className="w-5 text-right font-mono font-bold text-text-dim">{row.rank}</span>
              <span className="min-w-0 flex-1 truncate">
                {row.profileHref ? <Link href={row.profileHref} className="font-semibold text-text hover:underline">{row.name}</Link> : <span className="font-semibold text-text">{row.name}</span>}
                <span className="ml-1 text-text-dim">{row.flair ?? verifiedRegionsLabel(row.verified)}</span>
              </span>
              <span className="font-mono font-bold tabular-nums text-accent-cyan">+{row.points}</span>
            </li>
          ))}
        </ol>
      )}
      <SignedIn>
        <LeaderboardOptIn onChanged={() => void board.mutate()} />
      </SignedIn>
    </Card>
  );
}

export function useReviewerPrefs(onChanged: () => void) {
  const { getToken } = useAuth();
  const me = useApi<ReviewerMe>("/v1/me/reviewer", { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = async (key: "leaderboardOptIn" | "weeklyDigest", value: boolean) => {
    if (busy || !me.data) return;
    const prev = me.data;
    setBusy(true);
    setSaveError(null);
    try {
      await me.mutate({ ...prev, [key]: value }, { revalidate: false });
      const next = await apiCall<ReviewerMe>(getToken, "/v1/me/reviewer", { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      await me.mutate(next, { revalidate: false });
      onChanged();
    } catch {
      await me.mutate(prev, { revalidate: false });
      setSaveError("Couldn't save that setting. Try again.");
    } finally { setBusy(false); }
  };
  return { me, busy, saveError, toggle };
}

function LeaderboardOptIn({ onChanged }: { onChanged: () => void }) {
  const { me, busy, saveError, toggle } = useReviewerPrefs(onChanged);
  if (me.error) return <p role="alert" className="mt-3 text-caption text-text-muted">Your reviewer settings couldn&apos;t load · <Button variant="ghost" size="sm" onClick={() => void me.mutate()}>Try again</Button></p>;
  if (!me.data) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3 text-caption">
      <p className="text-text-muted">
        You: <strong className="text-text">{me.data.stats.karma} karma</strong> · {verifiedRegionsLabel(me.data.verified)}
        {me.data.badges.length ? ` · ${me.data.badges.map((b) => b.label).join(", ")}` : ""}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={busy} checked={me.data.leaderboardOptIn} onChange={(e) => void toggle("leaderboardOptIn", e.target.checked)} className="h-4 w-4" />
        Show my name on the leaderboard
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={busy} checked={me.data.weeklyDigest} onChange={(e) => void toggle("weeklyDigest", e.target.checked)} className="h-4 w-4" />
        Weekly digest of open requests in my matchups
      </label>
      {saveError ? <p role="alert" className="text-danger">{saveError}</p> : null}
    </div>
  );
}
