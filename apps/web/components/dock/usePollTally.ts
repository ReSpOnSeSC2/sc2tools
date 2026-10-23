"use client";
import { useRef } from "react";
import { tallyPollVotes } from "@/lib/multichat/poll";
import type { StudioPoll } from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
/** Match the OBS poll: late chat cannot change the closed result. */
export function usePollTally(messages: ReadonlyArray<ChatMessage>, poll: StudioPoll | null) {
  const frozen = useRef<{ key: number; tally: ReturnType<typeof tallyPollVotes> } | null>(null);
  if (!poll) { frozen.current = null; return null; }
  if (poll.status === "open" || frozen.current?.key !== poll.startedAtMs) frozen.current = { key: poll.startedAtMs, tally: tallyPollVotes(messages, poll) };
  return frozen.current?.tally ?? null;
}
