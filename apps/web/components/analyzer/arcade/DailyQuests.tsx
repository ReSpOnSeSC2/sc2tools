"use client";

/**
 * Daily Ladder Quests — the improvement-loop card on the Arcade's Today
 * surface. Three quests per day, derived from the player's own history
 * (lib/dailyQuests.ts), auto-verified from ingested replays, paying
 * Arcade XP.
 *
 * XP claiming — how it integrates with the engine:
 *   The arcade's XP ledger is ArcadeState.xp, mutated through
 *   useArcadeState (server-persisted to /v1/me/preferences/arcade, level
 *   recomputed on every write). Modes award XP via recordPlay(), but
 *   recordPlay is per-attempt and NOT idempotent — calling it twice adds
 *   XP twice and pollutes per-mode records/streak with a synthetic mode
 *   id. Quests need exactly-once semantics, so we award through the same
 *   sanctioned `update()` mutator recordPlay itself uses, guarded by the
 *   questClaimsByDay ledger: the mutator no-ops when (day, questId) is
 *   already claimed, which stays correct across re-renders, remounts,
 *   multiple devices (ledger is server-persisted) AND the pre-hydrate
 *   mutation-queue replay (mutators re-check `prev` at drain time —
 *   same pattern Buildle/Bingo use).
 *
 * Daily key: useDailySeed().day — ArcadeEngine.todayKey in the user's
 * IANA tz, the exact convention the Daily Drop / Buildle use.
 */

import { useEffect, useMemo } from "react";
import { CheckCircle2, Swords } from "lucide-react";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import {
  DAILY_QUEST_COUNT,
  evaluateQuests,
  selectDailyQuests,
  type QuestEvaluation,
} from "@/lib/dailyQuests";
import { useArcadeData } from "./hooks/useArcadeData";
import { useArcadeState } from "./hooks/useArcadeState";
import { useDailySeed } from "./hooks/useDailySeed";
import type { QuestClaim } from "./types";

/** Keep the per-day claim ledger bounded (~3 kB blob budget). */
const QUEST_LEDGER_MAX_DAYS = 30;

export function DailyQuests() {
  const { data, loading } = useArcadeData();
  const seed = useDailySeed();
  const { state, update, hydrated } = useArcadeState();
  const games = useMemo(() => data?.games ?? [], [data?.games]);

  const selection = useMemo(
    () => selectDailyQuests(seed.day, games, DAILY_QUEST_COUNT, seed.userId),
    [seed.day, seed.userId, games],
  );
  const evaluations = useMemo(
    () => evaluateQuests(selection.quests, games, seed.day, seed.tz, selection.context),
    [selection, games, seed.day, seed.tz],
  );

  const dayClaims: Record<string, QuestClaim> =
    state.questClaimsByDay?.[seed.day] ?? {};

  // Auto-claim: award XP once per (day, quest) the moment the quest
  // verifies done. Idempotent — see the module docblock.
  useEffect(() => {
    if (!hydrated) return;
    const day = seed.day;
    for (const ev of evaluations) {
      if (!ev.done) continue;
      const quest = ev.quest;
      update((prev) => {
        if (prev.questClaimsByDay?.[day]?.[quest.id]) return prev;
        const ledger: Record<string, Record<string, QuestClaim>> = {
          ...(prev.questClaimsByDay ?? {}),
        };
        ledger[day] = {
          ...(ledger[day] ?? {}),
          [quest.id]: { claimedAt: new Date().toISOString(), xp: quest.xp },
        };
        // Prune the oldest day keys ("YYYY-MM-DD" sorts chronologically).
        const keys = Object.keys(ledger).sort();
        while (keys.length > QUEST_LEDGER_MAX_DAYS) {
          delete ledger[keys.shift() as string];
        }
        return {
          ...prev,
          xp: { ...prev.xp, total: prev.xp.total + Math.max(0, quest.xp) },
          questClaimsByDay: ledger,
        };
      });
    }
  }, [evaluations, hydrated, seed.day, update]);

  const doneCount = evaluations.filter((e) => e.done).length;

  const title = (
    <span className="inline-flex items-center gap-2">
      <Swords className="h-5 w-5 text-accent-cyan" aria-hidden />
      Daily Quests
    </span>
  );

  if (loading && games.length === 0) {
    return (
      <Card title={title}>
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (games.length === 0) {
    return (
      <Card title={title}>
        <EmptyStatePanel
          size="sm"
          icon={<Swords className="h-5 w-5 text-text-muted" aria-hidden />}
          title="Quests unlock with your first game"
          description="Upload a replay and three daily quests appear here — personalized from your own ladder history and auto-verified from your games."
        />
      </Card>
    );
  }

  return (
    <Card
      title={title}
      right={
        <span className="text-caption font-semibold tabular-nums text-text-muted">
          {doneCount}/{evaluations.length} done
        </span>
      }
    >
      {evaluations.length === 0 ? (
        // Defensive: with ≥1 game the participation quest is always
        // eligible, so this branch should be unreachable.
        <EmptyStatePanel
          size="sm"
          title="No quests today"
          description="Play a few more games to unlock daily quests."
        />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="Today's quests">
            {evaluations.map((ev) => (
              <QuestRow key={ev.quest.id} ev={ev} claim={dayClaims[ev.quest.id] ?? null} />
            ))}
          </ul>
          <p className="text-micro text-text-dim">
            New quests every day — auto-verified from your uploaded replays.
          </p>
        </div>
      )}
    </Card>
  );
}

function QuestRow({ ev, claim }: { ev: QuestEvaluation; claim: QuestClaim | null }) {
  const { quest, progress, done } = ev;
  const pct = quest.target > 0 ? Math.round((progress / quest.target) * 100) : 0;
  const claimed = claim !== null;

  return (
    <li className="rounded-lg border border-border bg-bg-elevated p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-body font-semibold text-text">
            {done ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
            ) : null}
            <span className="min-w-0">{quest.title}</span>
          </p>
          <p className="text-caption text-text-muted">{quest.description}</p>
        </div>
        {claimed ? (
          <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-caption font-bold text-success">
            Claimed +{claim.xp} XP
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-caption font-bold tabular-nums text-accent">
            +{quest.xp} XP
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={quest.target}
          aria-valuenow={progress}
          aria-label={`${quest.title}: ${progress} of ${quest.target}`}
          className="h-1.5 flex-1 overflow-hidden rounded bg-bg-surface"
        >
          <div
            className={`h-full ${done ? "bg-success" : "bg-accent-cyan"} transition-[width] duration-150 motion-reduce:transition-none`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <span className="font-mono text-micro tabular-nums text-text-dim">
          {progress}/{quest.target}
        </span>
      </div>
    </li>
  );
}
