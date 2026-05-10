"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { ALL_MODES, modeById } from "../modes";
import { ModeRunner } from "../ModeRunner";
import { IconFor } from "../icons";
import type { ModeKind, ModeTtp } from "../types";

const KIND_FILTERS: Array<{ value: "all" | ModeKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "quiz", label: "Quizzes" },
  { value: "game", label: "Games" },
];

const TTP_FILTERS: Array<{ value: "all" | ModeTtp; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "fast", label: "Under 60 s" },
  { value: "medium", label: "5 minutes" },
  { value: "long", label: "Long" },
];

export function QuickPlaySurface() {
  const [kind, setKind] = useState<"all" | ModeKind>("all");
  const [ttp, setTtp] = useState<"all" | ModeTtp>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      ALL_MODES.filter((m) => {
        if (kind !== "all" && m.kind !== kind) return false;
        if (ttp !== "all" && m.ttp !== ttp) return false;
        return true;
      }),
    [kind, ttp],
  );

  const open = openId ? modeById(openId) : null;

  if (open) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setOpenId(null)}
          className="inline-flex min-h-[40px] items-center text-caption text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ← Back to Quick Play
        </button>
        <ModeRunner mode={open} isDaily={false} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">Mode kind</legend>
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setKind(f.value)}
            aria-pressed={kind === f.value}
            className={[
              "inline-flex min-h-[36px] items-center rounded-full border px-3 text-caption font-semibold",
              kind === f.value
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-bg-surface text-text hover:bg-bg-elevated",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" aria-hidden />
        {TTP_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setTtp(f.value)}
            aria-pressed={ttp === f.value}
            className={[
              "inline-flex min-h-[36px] items-center rounded-full border px-3 text-caption",
              ttp === f.value
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-bg-surface text-text hover:bg-bg-elevated",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
      </fieldset>

      <ul role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((m) => (
          <li key={m.id}>
            <Card variant="interactive" className="h-full">
              <button
                type="button"
                onClick={() => setOpenId(m.id)}
                className="flex h-full w-full flex-col items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-elevated text-accent-cyan">
                  {IconFor(m.id)}
                </span>
                <span className="text-body font-semibold text-text">{m.title}</span>
                <span className="text-caption text-text-muted">{m.blurb}</span>
                <span className="mt-auto inline-flex items-center gap-2 text-caption text-text-dim">
                  <Pill>{m.kind}</Pill>
                  <Pill>{m.depthTag}</Pill>
                  <Pill>{m.ttp}</Pill>
                </span>
              </button>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider">
      {children}
    </span>
  );
}
