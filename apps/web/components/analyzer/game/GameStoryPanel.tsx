"use client";

import { Component, Suspense, lazy, useCallback, useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui/Tabs";
import type { GameStoryInput } from "@/lib/gameStory";

const makeStory = () => lazy(() => import("./GameStoryCard").then(module => ({ default: module.GameStoryCard })));
type Props = { input: GameStoryInput; mechanics: ReactNode; lossAutopsy?: ReactNode; onSeek: (time: number) => void };

/** Only the lightweight layout is eager; math, prices and ledger load together.
 * Mechanics and the default loss analysis stay mounted while the chunk loads. */
export function GameStoryPanel({ input, mechanics, lossAutopsy, onSeek }: Props) {
  const [Story, setStory] = useState(makeStory);
  const [hasStory, setHasStory] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState("loss");
  const failed = useCallback(() => setLoadError(true), []);
  const isLoss = lossAutopsy != null;
  const available = hasStory || loadError;
  const retry = () => { setStory(makeStory); setLoadError(false); setAttempt(value => value + 1); };
  const story = <StoryChunkBoundary key={attempt} onError={failed} fallback={<div role="alert" className="space-y-2 rounded-lg border border-border p-4"><p className="text-caption">Game story could not load. The other analysis remains available.</p><button type="button" onClick={retry} className="min-h-11 rounded-md border border-border px-3 text-caption hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Try game story again</button></div>}>
    <Suspense fallback={null}><Story input={input} onSeek={onSeek} onAvailabilityChange={setHasStory} /></Suspense>
  </StoryChunkBoundary>;
  return <div className={`grid min-w-0 gap-6 ${isLoss || available ? "md:grid-cols-2" : "grid-cols-1"}`} data-testid="game-story-layout">
    <div className="min-w-0">{mechanics}</div>
    {isLoss ? <Tabs value={available ? tab : "loss"} onValueChange={setTab} className="min-w-0">
      <Tabs.List ariaLabel="Game analysis"><Tabs.Trigger value="loss">Why you lost</Tabs.Trigger>{available ? <Tabs.Trigger value="story">Game story</Tabs.Trigger> : null}</Tabs.List>
      <Tabs.Content value="loss" keepMounted>{lossAutopsy}</Tabs.Content>
      <Tabs.Content value="story" keepMounted>{story}</Tabs.Content>
    </Tabs> : <div className="min-w-0" hidden={!available}>{story}</div>}
  </div>;
}

class StoryChunkBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
