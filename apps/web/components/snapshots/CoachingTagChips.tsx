"use client";

import { Card } from "@/components/ui/Card";
import { fmtTick, type CoachingTagRow } from "./shared/snapshotTypes";

// Per-tick coaching tags. Filters down to the focused tick (if
// pinned) so the user sees the relevant chips without scanning the
// whole list; if unfocused, shows a unique-tags overview.

const TAG_LABELS: Record<string, { label: string; tone: "warn" | "info" | "alert" }> = {
  "worker-deficit-early": { label: "Worker deficit (early)", tone: "warn" },
  "tech-rushed": { label: "Tech rushed", tone: "info" },
  "over-expanded": { label: "Over-expanded", tone: "warn" },
  "over-droned": { label: "Over-droned (late)", tone: "warn" },
  "supply-blocked": { label: "Supply-blocked", tone: "alert" },
  "income-starved": { label: "Income-starved", tone: "alert" },
};

const TONE_CLASSES: Record<"warn" | "info" | "alert", string> = {
  warn: "border-warning/40 bg-warning/10 text-warning",
  info: "border-accent/40 bg-accent/10 text-accent",
  alert: "border-danger/40 bg-danger/10 text-danger",
};

export interface CoachingTagChipsProps {
  rows: CoachingTagRow[];
  focusedTick: number | null;
}

export function CoachingTagChips({ rows, focusedTick }: CoachingTagChipsProps) {
  if (!rows || rows.length === 0) {
    return (
      <Card title="Coaching tags">
        <p className="py-3 text-center text-caption text-text-dim">
          No coaching tags fired in this game.
        </p>
      </Card>
    );
  }

  if (focusedTick !== null) {
    const focusRow = rows.find((r) => r.t === focusedTick);
    if (!focusRow) {
      return (
        <Card title="Coaching tags">
          <p className="py-3 text-center text-caption text-text-dim">
            No tags at {fmtTick(focusedTick)}.
          </p>
        </Card>
      );
    }
    return (
      <Card title={`Tags @ ${fmtTick(focusedTick)}`}>
        <div className="flex flex-wrap gap-2">
          {focusRow.tags.map((tag) => (
            <Chip key={tag} tag={tag} />
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Coaching tags">
      <ul className="space-y-1.5" role="list">
        {rows.slice(0, 20).map((row) => (
          <li key={row.t} className="flex items-baseline gap-2 text-caption">
            <span className="w-12 shrink-0 text-text-dim">{fmtTick(row.t)}</span>
            <div className="flex flex-wrap gap-1">
              {row.tags.map((tag) => (
                <Chip key={tag} tag={tag} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Chip({ tag }: { tag: string }) {
  const meta = TAG_LABELS[tag] || { label: tag, tone: "info" as const };
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        TONE_CLASSES[meta.tone],
      ].join(" ")}
    >
      {meta.label}
    </span>
  );
}
