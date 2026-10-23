"use client";
import { useEffect, useState } from "react";
import { REPLAY_INPUT_ACCEPT, replayInputAccept } from "@/lib/instant/fileIntake";
/** `accept` for the picker, decided after mount (navigator is client-only). */
export function useReplayAccept(): string | undefined {
  const [accept, setAccept] = useState<string | undefined>(REPLAY_INPUT_ACCEPT);
  useEffect(() => {
    setAccept(replayInputAccept(navigator.userAgent, navigator.maxTouchPoints));
  }, []);
  return accept;
}
