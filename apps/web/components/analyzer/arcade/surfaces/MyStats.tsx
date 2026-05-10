"use client";

import { fmtAgo } from "@/lib/format";
import { Card, Stat } from "@/components/ui/Card";
import { ALL_MODES } from "../modes";
import { StreakHUD } from "../hud/StreakHUD";
import { XpBar } from "../hud/XpBar";
import { useArcadeState } from "../hooks/useArcadeState";

export function MyStatsSurface() {
  const { state } = useArcadeState();
  const totalAttempts = Object.values(state.records).reduce(
    (s, r) => s + r.attempts,
    0,
  );
  const totalCorrect = Object.values(state.records).reduce(
    (s, r) => s + r.correct,
    0,
  );
  const accuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0;

  return (
    <div className="space-y-5">
      <Card title="Overview">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Streak" value={`${state.streak.count}🔥`} />
          <Stat label="Level" value={state.xp.level} />
          <Stat
            label="Accuracy"
            value={`${Math.round(accuracy * 100)}%`}
          />
          <Stat label="Minerals" value={state.minerals} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StreakHUD streak={state.streak.count} />
          <XpBar xp={state.xp.total} level={state.xp.level} />
        </div>
      </Card>

      <Card title="Per-mode records">
        <ul className="divide-y divide-border" role="list">
          {ALL_MODES.map((m) => {
            const rec = state.records[m.id];
            const attempts = rec?.attempts ?? 0;
            const correct = rec?.correct ?? 0;
            const acc = attempts > 0 ? correct / attempts : 0;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-caption"
              >
                <span className="text-text">{m.title}</span>
                <span className="font-mono tabular-nums text-text-dim">
                  {attempts === 0
                    ? "—"
                    : `${Math.round(acc * 100)}% · ${attempts} played${rec?.bestRun ? ` · best run ${rec.bestRun}` : ""}`}{" "}
                  {rec ? <span className="text-text-dim">· {fmtAgo(rec.lastPlayedAt)}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
