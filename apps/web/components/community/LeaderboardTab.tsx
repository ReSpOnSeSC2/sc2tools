"use client";

import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CloudOff, LogIn, Medal, Trophy } from "lucide-react";
import { weekKey } from "@/components/analyzer/arcade/ArcadeEngine";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { SkeletonBar as Skeleton } from "@/components/ui/Skeleton";
import { signInHref } from "@/lib/authLinks";
import { useApi } from "@/lib/clientApi";
import { formatWeekRange, shiftWeekKey, weekKeyToRange } from "@/lib/isoWeek";
import { useState } from "react";

interface ApiRow { rank: number | null; displayName: string; pnlPct: number; isAnonymous: boolean; settled: boolean; isYou: boolean }
interface ApiResponse { weekKey: string; items: ApiRow[]; participants: number; settledCount: number; you: { rank: number | null; pnlPct: number; settled: boolean } | null }
const pnl = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
function selectedWeek(raw: string | null, current: string) { return raw && weekKeyToRange(raw) && raw <= current ? raw : shiftWeekKey(current, -1); }
function currentWeek() { return weekKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); }

export function LeaderboardSkeleton() {
  return <div aria-label="Loading leaderboard" role="status" className="space-y-3"><Skeleton className="h-20 w-full" />{Array.from({ length: 5 }, (_, index) => <div key={index} className="grid grid-cols-[40px_1fr_70px] gap-4"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>)}</div>;
}

export function LeaderboardTab() {
  const { isLoaded } = useAuth();
  const search = useSearchParams();
  if (!isLoaded) return <LeaderboardSkeleton />;
  const week = search.get("week");
  const returnTo = `/community/leaderboard${week && weekKeyToRange(week) && week <= currentWeek() ? `?week=${week}` : ""}`;
  return <><SignedIn><LeaderboardBoard /></SignedIn><SignedOut><EmptyStatePanel icon={<LogIn aria-hidden />} title="Sign in to see this week's leaderboard" description="The board shows player names, so it's only visible to signed-in players. Portfolios always stay private." action={<div className="flex flex-wrap justify-center gap-4"><Link href={signInHref(returnTo)} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Sign in</Link><Link href="/sign-up" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Sign up free</Link></div>} /></SignedOut></>;
}

function LeaderboardBoard() {
  const search = useSearchParams(); const router = useRouter();
  const current = currentWeek(); const viewed = selectedWeek(search.get("week"), current);
  const [limit, setLimit] = useState(50);
  const query = useApi<ApiResponse>(`/v1/arcade/leaderboard?weekKey=${viewed}&limit=${limit}`);
  const choose = (week: string) => { setLimit(50); router.replace(`/community/leaderboard?week=${week}`, { scroll: false }); };
  return <div className="space-y-4">
    <Card><div className="flex flex-wrap items-center gap-3"><Trophy className="h-5 w-5 text-warning" aria-hidden /><h2 className="text-body font-semibold">Weekly P&amp;L</h2><LazyHelpLink slug="stock-market-leaderboard">How the leaderboard works</LazyHelpLink></div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Button variant="secondary" onClick={() => choose(shiftWeekKey(viewed, -1))}>‹ Prev week</Button><span className="text-caption font-semibold">{formatWeekRange(viewed)}</span><Button variant="secondary" disabled={viewed === current} onClick={() => choose(shiftWeekKey(viewed, 1))}>Next week ›</Button>{viewed !== current ? <Button variant="ghost" onClick={() => choose(current)}>This week</Button> : null}</div>
      {viewed === current ? <div className="mt-3"><Badge variant="warning">In progress — results post after the week ends</Badge></div> : null}
    </Card>
    {query.isLoading || query.isPreviousData ? <LeaderboardSkeleton /> : query.error ? <EmptyStatePanel icon={<CloudOff aria-hidden />} title="Couldn't load the leaderboard" description="Try again in a moment." action={<Button onClick={() => void query.mutate()}>Retry</Button>} /> : query.data ? <>
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-caption" role="status">{query.data.you ? query.data.you.settled && viewed !== current ? `Your rank: #${query.data.you.rank} of ${query.data.participants} · ${pnl(query.data.you.pnlPct)}` : "You're on this week's board — locked" : <>You&apos;re not on this board. Opt in when you lock a portfolio. <Link href="/app/arcade" className="font-semibold text-accent underline">Open the Stock Market</Link></>}</div>
      {!query.data.items.length ? <EmptyStatePanel title="No one has posted for this week yet" action={<Link href="/app/arcade" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Open the Stock Market</Link>} /> : <Card padded={false}><div className="overflow-x-auto"><table className="w-full text-caption"><caption className="sr-only">Stock Market weekly P&amp;L, {formatWeekRange(viewed)}</caption><thead className="border-b border-border bg-bg-elevated text-left text-text-dim"><tr><th className="px-3 py-2">Rank</th><th className="px-3 py-2">Player</th><th className="px-3 py-2 text-right">Weekly P&amp;L</th></tr></thead><tbody>{query.data.items.map((row, index) => <tr key={index} className={`border-b border-border last:border-0 ${row.isYou ? "bg-accent/10" : ""}`}><td className="px-3 py-3">{row.settled && row.rank && viewed !== current ? <span className="inline-flex items-center gap-1">{row.rank <= 3 ? <Medal aria-label={`${["1st", "2nd", "3rd"][row.rank - 1]} place`} className={`h-4 w-4 ${["text-warning", "text-text-muted", "text-orange-600"][row.rank - 1]}`} /> : null}{row.rank}</span> : "—"}</td><td className="px-3 py-3">{row.displayName} {row.isYou ? <Badge>You</Badge> : null}</td><td className={`px-3 py-3 text-right tabular-nums ${row.settled ? "text-text" : "text-text-dim"}`}>{viewed === current ? "Locked" : row.settled ? pnl(row.pnlPct) : "Awaiting result"}</td></tr>)}</tbody></table></div></Card>}
      {query.data.participants > query.data.items.length && limit < 200 ? <Button variant="secondary" onClick={() => setLimit(200)}>Show more</Button> : null}
    </> : null}
  </div>;
}
