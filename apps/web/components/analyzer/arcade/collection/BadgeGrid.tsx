"use client";

import { Trophy } from "lucide-react";

const BADGES = [
  { id: "streak-hunter", title: "Streak Hunter", desc: "Streak Hunter perfect 5-day run." },
  { id: "veto-sleuth", title: "Veto Sleuth", desc: "3 Streak Veto correct in a row." },
  { id: "tycoon", title: "Tycoon", desc: "Stock Market 5-week green streak." },
  { id: "buildle-brain", title: "Buildle Brain", desc: "Crack 5 Buildle dailies in a row." },
  { id: "closer", title: "Closer", desc: "Closer's Eye perfect 5-day run." },
  { id: "detective", title: "Detective", desc: "Loss-Pattern Sleuth perfect 5-day run." },
] as const;

export function BadgeGrid({
  earned,
}: {
  earned: Record<string, { earnedAt: string }>;
}) {
  return (
    <ul role="list" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {BADGES.map((b) => {
        const got = earned[b.id];
        return (
          <li
            key={b.id}
            className={[
              "flex flex-col items-center gap-2 rounded-lg border p-3 text-center",
              got
                ? "border-warning/50 bg-warning/10 text-text"
                : "border-border bg-bg-elevated text-text-dim",
            ].join(" ")}
          >
            <Trophy
              className={["h-7 w-7", got ? "text-warning" : "text-text-dim"].join(" ")}
              aria-hidden
            />
            <span className="text-body font-semibold text-text">{b.title}</span>
            <span className="text-caption">{b.desc}</span>
            {got ? (
              <span className="text-[10px] font-mono uppercase tracking-wider text-warning">
                Earned
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
