"use client";

import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { RewardSpeechHandler } from "./twitchRewardSpeechSubscription";

export function useTwitchRewardSpeech(
  socket: Socket | null | undefined,
  ready: RewardSpeechHandler["ready"],
  speak: RewardSpeechHandler["speak"],
  blocked: RewardSpeechHandler["blocked"],
) {
  const handler = useRef({ ready, speak, blocked });
  const results = useRef(new Map<string, Promise<boolean>>());
  handler.current = { ready, speak, blocked };
  useEffect(() => {
    if (!socket) return;
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./twitchRewardSpeechSubscription").then(({ subscribeTwitchRewardSpeech }) => {
      if (active) dispose = subscribeTwitchRewardSpeech(socket, () => handler.current, results.current);
    }).catch(() => { /* No readiness ACK if the optional listener failed to load. */ });
    return () => { active = false; dispose?.(); };
  }, [socket]);
}
