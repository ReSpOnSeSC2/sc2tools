"use client";

import { useRef } from "react";
import { pollIsClosed, pollResultSettling, pollVoteCutoffMs, tallyPollVotes } from "./poll";
import type { StudioPoll } from "./useStudioState";
import type { ChatMessage } from "./types";

/** Keep one tally for the current poll and freeze it after its cutoff settles. */
export function usePollTally(messages: ReadonlyArray<ChatMessage>, poll: StudioPoll | null, now = Date.now()) {
  const frozen = useRef<{ key: number; cutoff: number | null; tally: ReturnType<typeof tallyPollVotes> } | null>(null);
  if (!poll) { frozen.current = null; return null; }
  const cutoff = pollVoteCutoffMs(poll);
  if (!pollIsClosed(poll, now) || pollResultSettling(poll, now) || frozen.current?.key !== poll.startedAtMs || frozen.current.cutoff !== cutoff) {
    frozen.current = { key: poll.startedAtMs, cutoff, tally: tallyPollVotes(messages, poll) };
  }
  return frozen.current.tally;
}
