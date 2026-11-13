"use client";

import { useEffect, useRef, useState } from "react";
import { matchReplayErrorText, readMatchReplay, replayAction, type MatchReplay, type ReplayOutcome } from "@/lib/matchRoomReplay";
import type { RoomAction, Seat } from "@/lib/matchRoom";

type ReplayState = { kind: "idle" } | { kind: "reading" } | { kind: "error"; message: string }
  | { kind: "ready"; replay: MatchReplay; failed?: boolean };

type ReplayOptions = { roomId: string; seat: Seat; send: (action: RoomAction) => Promise<boolean> };

export function useRoomReplay({ roomId, seat, send }: ReplayOptions) {
  const [state, setState] = useState<ReplayState>({ kind: "idle" });
  const [sending, setSending] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const reportPending = useRef(false);
  useEffect(() => () => pending.current?.abort(), []);

  function close() {
    pending.current?.abort();
    pending.current = null;
    setState({ kind: "idle" });
    setSending(false);
  }

  async function read(files: FileList | null) {
    if (!files?.length || reportPending.current) return;
    pending.current?.abort();
    if (files.length !== 1) {
      setState({ kind: "error", message: "Choose one replay at a time." });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState({ kind: "reading" });
    try {
      const replay = await readMatchReplay(files[0], roomId, controller.signal);
      if (!controller.signal.aborted) setState({ kind: "ready", replay });
    } catch (error) {
      if (!controller.signal.aborted) setState({ kind: "error", message: matchReplayErrorText(error) });
    }
  }

  async function report(outcome: ReplayOutcome) {
    const controller = pending.current;
    if (state.kind !== "ready" || !controller || reportPending.current) return;
    reportPending.current = true;
    setSending(true);
    setState({ ...state, failed: false });
    try {
      const action = await replayAction(state.replay, seat, outcome);
      if (controller.signal.aborted) return;
      const saved = await send(action);
      if (controller.signal.aborted) return;
      if (saved) close();
      else setState({ ...state, failed: true });
    } catch (error) {
      if (!controller.signal.aborted) setState({ kind: "error", message: matchReplayErrorText(error) });
    } finally {
      reportPending.current = false;
      setSending(false);
    }
  }

  return { state, sending, read, report, close };
}
