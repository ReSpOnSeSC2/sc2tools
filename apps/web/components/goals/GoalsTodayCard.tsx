"use client";

import Link from "next/link";
import { Target } from "lucide-react";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { todayGoals } from "@/lib/goals";
import { useGoals } from "./useGoals";
import { GoalProgress } from "./GoalProgress";

const LINK_CLASS = "rounded-sm text-caption text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Today's Goals card: up to three pinned goals with their live progress
 * bars and sample guards, a link to manage them on /app/goals, and a
 * starting prompt when no goal is pinned yet.
 */
export function GoalsTodayCard() {
  const goals = useGoals();
  const data = goals.data;
  const shown = data ? todayGoals(data.goals) : [];
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Target className="h-4 w-4 text-accent-cyan" aria-hidden />Goals</span>}
      headingLevel={2}
      right={<Link href="/app/goals" className={LINK_CLASS}>{data && data.goals.length > 0 ? "Manage goals" : "Set a goal"}</Link>}
      data-testid="today-goals"
    >
      {goals.error && !data ? (
        <RequestError title="Couldn't load your goals" error={goals.error} onRetry={() => void goals.mutate()} />
      ) : !data ? (
        <Skeleton rows={2} />
      ) : shown.length === 0 ? (
        <p className="text-caption text-text-muted">
          {data.goals.length > 0
            ? "Pin up to three goals to see them here."
            : "Pick a target: games this week, a win rate, an MMR, macro or build practice. Progress fills in from your replays."}
        </p>
      ) : (
        <ul className="space-y-4">
          {shown.map((goal) => <li key={goal.id}><GoalProgress goal={goal} compact /></li>)}
        </ul>
      )}
    </Card>
  );
}
