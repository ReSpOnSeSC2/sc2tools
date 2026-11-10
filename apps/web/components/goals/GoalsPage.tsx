"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { Card, Skeleton } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequestError } from "@/components/ui/RequestError";
import { useConfirm } from "@/components/ui/useConfirm";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { formatDay, progressText, type Goal, type GoalsResponse } from "@/lib/goals";
import { GoalProgress } from "./GoalProgress";
import { useGoals } from "./useGoals";

const NewGoalModal = dynamic(() => import("./NewGoalModal").then((mod) => mod.NewGoalModal));

/**
 * /app/goals — active goals with live progress (pin up to three to Today),
 * the completed history, and the New goal modal. Every write returns the
 * full list, which replaces the cache without a second read.
 */
export function GoalsPage() {
  const { getToken } = useAuth();
  const goals = useGoals();
  const { confirm, dialog } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientApiError | null>(null);
  const data = goals.data;
  const atLimit = !!data && data.goals.length >= data.limits.maxActive;
  const pinned = data ? data.goals.filter((goal) => goal.pinned).length : 0;

  async function write(id: string, init: RequestInit) {
    setBusy(id);
    setError(null);
    try {
      const next = await apiCall<GoalsResponse>(getToken, `/v1/goals/${encodeURIComponent(id)}`, init);
      await goals.mutate(next, { revalidate: false });
    } catch (cause) {
      setError(cause as ClientApiError);
    } finally {
      setBusy(null);
    }
  }

  async function remove(goal: Goal) {
    const ok = await confirm({ title: "Delete this goal?", description: goal.label, confirmLabel: "Delete", intent: "danger" });
    if (ok) await write(goal.id, { method: "DELETE" });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Goals"
        description="Targets that track themselves from your replays: games, win rate, MMR, macro and build practice."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <LazyHelpLink slug="goals">How goals work</LazyHelpLink>
            <Button iconLeft={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating(true)} disabled={atLimit}>New goal</Button>
          </div>
        }
      />
      {atLimit ? <p className="text-caption text-text-muted">You have {data?.limits.maxActive} active goals, the most at once. Delete one to add another.</p> : null}
      {error ? <RequestError title="Couldn't update the goal" error={error} /> : null}
      {goals.error && !data ? <RequestError title="Couldn't load your goals" error={goals.error} onRetry={() => void goals.mutate()} /> : null}
      {!data && !goals.error ? <Card><Skeleton rows={4} /></Card> : null}
      {data ? (
        <>
          <Card title={`Active (${data.goals.length} of ${data.limits.maxActive})`} headingLevel={2}>
            {data.goals.length === 0 ? (
              <p className="text-caption text-text-muted">No active goals. Start with a template: weekly games, a win rate, an MMR for the season, macro or a build to practise.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.goals.map((goal) => (
                  <li key={goal.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1"><GoalProgress goal={goal} /></div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-pressed={goal.pinned}
                        disabled={busy === goal.id || (!goal.pinned && pinned >= data.limits.maxPinned)}
                        title={!goal.pinned && pinned >= data.limits.maxPinned ? `Up to ${data.limits.maxPinned} goals show on Today` : undefined}
                        iconLeft={goal.pinned ? <PinOff className="h-4 w-4" aria-hidden /> : <Pin className="h-4 w-4" aria-hidden />}
                        onClick={() => void write(goal.id, { method: "PUT", body: JSON.stringify({ pinned: !goal.pinned }) })}
                      >
                        {goal.pinned ? "Unpin from Today" : "Pin to Today"}
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${goal.label}`} disabled={busy === goal.id} iconLeft={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => void remove(goal)}>Delete</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Completed" headingLevel={2}>
            {data.completed.length === 0 ? (
              <p className="text-caption text-text-muted">Reached and ended goals land here.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.completed.map((goal) => (
                  <li key={goal.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
                    <Badge variant={goal.outcome === "met" ? "success" : "neutral"}>{goal.outcome === "met" ? "Reached" : "Ended"}</Badge>
                    <span className="min-w-0 flex-1 break-words text-body text-text">{goal.label}</span>
                    <span className="text-caption tabular-nums text-text-muted">{progressText(goal)}</span>
                    {goal.completedAt ? <span className="text-caption text-text-dim">{formatDay(goal.completedAt.slice(0, 10))}</span> : null}
                    <Button variant="ghost" size="sm" aria-label={`Delete ${goal.label}`} disabled={busy === goal.id} onClick={() => void remove(goal)}>Delete</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
      {creating ? <NewGoalModal open onClose={() => setCreating(false)} onCreated={(next) => void goals.mutate(next, { revalidate: false })} /> : null}
      {dialog}
    </div>
  );
}
