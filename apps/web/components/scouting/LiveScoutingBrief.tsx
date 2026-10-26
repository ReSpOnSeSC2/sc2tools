"use client";
import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { loadScoutingBriefCard } from "./scoutingBriefLoader";
import { useLiveScouting } from "./useLiveScouting";

const makeCard = () => lazy(loadScoutingBriefCard);

export function LiveScoutingBrief() {
  const { live, unavailable, retry } = useLiveScouting();
  const [Card, setCard] = useState(makeCard), [attempt, setAttempt] = useState(0);
  const retryChunk = () => { setCard(makeCard); setAttempt(value => value + 1); };
  return live ? <BriefChunkBoundary key={attempt} fallback={<div role="alert" className="space-y-2 rounded-xl border border-border bg-bg-surface p-4"><p className="text-caption text-text-muted">The live brief could not load. Your other dashboard panels remain available.</p><button type="button" onClick={retryChunk} className="min-h-11 rounded-full border border-line px-4 text-caption font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry live brief</button></div>}>
    <Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading live brief…</p>}><Card key={live.gameKey || live.opponent?.name} live={live} unavailable={unavailable} onRetry={retry} /></Suspense>
  </BriefChunkBoundary> : null;
}

/** Keep the SSE hook above this boundary so a failed optional chunk stays local. */
class BriefChunkBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
