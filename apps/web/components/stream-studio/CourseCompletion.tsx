"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { OVERLAY_STARTER_PACKS } from "@/lib/overlayStarterPacks";
import { AUTOMATIC_LESSONS, type ReadinessCheck } from "@/lib/streamReadiness";
import type { StarterWidgetStatus } from "@/lib/useStreamReadiness";

export type CourseSetup = { owner: string; checks: ReadonlyArray<ReadinessCheck>; starterWidgets: StarterWidgetStatus };
type AutoState = { owner?: string; accepted: string[]; skipped: string[] };
const EMPTY: AutoState = { accepted: [], skipped: [] };
const ADD_NEXT = [
  { name: "A practice night", href: "/stream-studio/learn#starter-practice" },
  { name: "A community night", href: "/stream-studio/learn#starter-community" },
  { name: "Widget playground", href: "/stream-studio/playground" },
  { name: "Build vote", href: "/stream-studio/learn?widget=chat-poll#widget-library" },
];

export function useAutomaticLessons(setup: CourseSetup | undefined) {
  const owner = setup?.owner;
  const eligible = setup?.checks.flatMap(check => {
    const lesson = AUTOMATIC_LESSONS[check.id];
    return lesson && check.state === "ok" ? [lesson] : [];
  }).join(",") ?? "";
  const [state, setState] = useState(EMPTY);
  const current = state.owner === owner ? state : EMPTY;

  useEffect(() => {
    setState(previous => {
      const baseline = previous.owner === owner ? previous : EMPTY;
      const accepted = [...new Set([...baseline.accepted, ...eligible.split(",").filter(id => id && !baseline.skipped.includes(id))])];
      return { owner, accepted, skipped: baseline.skipped };
    });
  }, [eligible, owner]);

  return {
    state: current,
    ignore: (id: string) => setState({ owner, accepted: current.accepted.filter(item => item !== id), skipped: [...current.skipped, id] }),
    reset: () => setState({ owner, accepted: [], skipped: [...current.accepted, ...current.skipped] }),
    restore: (saved: AutoState) => { if (saved.owner === owner) setState(saved); },
  };
}

export function CourseCompletion({ lessons, widgets }: { lessons: readonly string[]; widgets?: StarterWidgetStatus }) {
  const starter = OVERLAY_STARTER_PACKS[0];
  return <section aria-labelledby="stream-course-complete" className="space-y-4 rounded-md border-2 border-line bg-bg-surface p-4 sm:p-6">
    <h3 id="stream-course-complete" className="text-body-lg font-semibold">Your first scene checklist</h3>
    <ul aria-label="Completed lessons" className="flex flex-wrap gap-2">{lessons.map(lesson => <li key={lesson}><Badge variant="success">{lesson}</Badge></li>)}</ul>
    <div className="grid gap-4 sm:grid-cols-2">
      <div><h4 className="mb-2 font-semibold">Starter widgets</h4>
        <ul className="space-y-2">{starter.widgets.map(widget => <li key={widget.id} className="flex flex-wrap items-center gap-2 text-caption">
          {widget.name}
          {widgets ? <Badge variant={widgets.state === "ready" && widgets.enabled.includes(widget.id) ? "success" : "neutral"}>
            {widgets.state === "error" ? "Couldn’t check" : widgets.state === "loading" ? "Checking…" : widgets.enabled.includes(widget.id) ? "Enabled" : "Not enabled"}
          </Badge> : null}
        </li>)}</ul>
      </div>
      <div><h4 className="mb-2 font-semibold">What to add next</h4>
        <ul>{ADD_NEXT.map(item => <li key={item.href}><Link href={item.href} className="inline-flex min-h-9 items-center text-caption text-accent underline">{item.name}</Link></li>)}</ul>
      </div>
    </div>
  </section>;
}
