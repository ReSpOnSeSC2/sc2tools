"use client";
import { useState } from "react";
import type { StudioPoll } from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
import { DockBuildVote } from "./DockBuildVote";
import { DockPoll } from "./DockPoll";
import type { DockPost } from "./dockActions";

export function DockPollCard({ token, poll, messages, busy, studioReady, onPost }: {
  token: string; poll: StudioPoll | null; messages: ReadonlyArray<ChatMessage>;
  busy: boolean; studioReady: boolean; onPost: DockPost;
}) {
  const [chosen, setChosen] = useState<"custom" | "build">("custom");
  // The saved poll owns the mode until it is cleared, including its final result.
  const mode = poll ? poll.meta?.kind === "build" ? "build" : "custom" : chosen;
  return <div className="space-y-3">
    <div role="group" aria-label="Poll mode" className="flex gap-1">
      {([['custom', 'Custom poll'], ['build', 'Build vote']] as const).map(([id, label]) => <button key={id} type="button"
        aria-pressed={mode === id} disabled={busy || !studioReady || Boolean(poll)} onClick={() => setChosen(id)}
        className={`rounded-md border px-2.5 py-1.5 text-caption disabled:opacity-60 ${mode === id ? "border-accent bg-accent/10 text-text" : "border-border text-text-muted"}`}>{label}</button>)}
    </div>
    {poll || mode === "custom" ? <DockPoll poll={poll} messages={messages} busy={busy} studioReady={studioReady} onPost={onPost} /> : null}
    {mode === "build" ? <DockBuildVote token={token} busy={busy} ready={studioReady} pollActive={Boolean(poll)} poll={poll} messages={messages} onPost={onPost} /> : null}
  </div>;
}
