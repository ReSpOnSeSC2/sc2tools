"use client";

import { useEffect, useRef, useState } from "react";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { gamesFromHeaders, headerIdentity, type KeyedHeader, yearLadderHeaders, yearReplayFiles } from "@/lib/career/headerRows";
import { MAX_REPLAY_BYTES } from "@/lib/instant/fileIntake";
import type { MeCandidate } from "@/lib/instant/meDetection";
import type { EngineProgress, IntakeFile, ReplaySource } from "@/lib/instant/types";
type Results = { rows: KeyedHeader[]; candidates: MeCandidate[]; unreadable: number };

export type RecapState =
  | { kind: "idle" }
  | { kind: "scanning"; total: number; complete: number }
  | { kind: "empty"; reason: "files" | "ladder" | "player" }
  | { kind: "error" }
  | ({ kind: "identify" } & Results)
  | { kind: "recap"; games: ArcadeGame[]; unreadable: number };

function recapState(rows: KeyedHeader[], unreadable: number, toon?: string): RecapState {
  const games = gamesFromHeaders(rows, toon);
  return games.length ? { kind: "recap", games, unreadable } : { kind: "empty", reason: "player" };
}

function progressHandler(signal: AbortSignal, setState: (state: RecapState) => void) {
  return (progress: EngineProgress) => {
    if (signal.aborted || progress.phase !== "header" || progress.ok === undefined) return;
    const complete = progress.index + 1;
    if (complete !== 1 && complete !== progress.total && complete % 10 !== 0) return;
    setState({ kind: "scanning", total: progress.total, complete });
  };
}

async function scanYear(files: IntakeFile[], signal: AbortSignal, setState: (state: RecapState) => void) {
  const candidates = yearReplayFiles(files);
  if (!candidates.length) return { kind: "empty", reason: "files" } as const;
  const eligible = candidates.filter((file) => file.size > 0 && file.size <= MAX_REPLAY_BYTES);
  if (!eligible.length) return { kind: "error" } as const;
  const { createEngineClient } = await import("@/lib/instant/engineClient");
  signal.throwIfAborted();
  const engine = createEngineClient({ refreshPolicy: false });
  setState({ kind: "scanning", total: eligible.length, complete: 0 });
  try {
    const scanned = await engine.scanHeaders(eligible, { signal, onProgress: progressHandler(signal, setState) });
    signal.throwIfAborted();
    const unreadable = candidates.length - eligible.length + scanned.filter((row) => !row.ok).length;
    const rows = yearLadderHeaders(eligible, scanned);
    if (unreadable === candidates.length) return { kind: "error" } as const;
    if (!rows.length) return { kind: "empty", reason: "ladder" } as const;
    const identity = headerIdentity(rows);
    if (identity.needsConfirmation) return { kind: "identify", rows, candidates: identity.candidates, unreadable } as const;
    return recapState(rows, unreadable);
  } finally {
    engine.dispose();
  }
}

export function useYearRecap() {
  const [state, setState] = useState<RecapState>({ kind: "idle" });
  const active = useRef<AbortController | null>(null);
  const lastSource = useRef<ReplaySource | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function start(source: ReplaySource) {
    if (active.current) return;
    lastSource.current = source;
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    setState({ kind: "scanning", total: 0, complete: 0 });
    try {
      const files = await source(signal);
      signal.throwIfAborted();
      const result = files ? await scanYear(files, signal, setState) : { kind: "idle" } as const;
      signal.throwIfAborted();
      if (result.kind !== "error") lastSource.current = null;
      setState(result);
    } catch {
      if (!signal.aborted) setState({ kind: "error" });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  function clear() {
    active.current?.abort();
    active.current = null;
    lastSource.current = null;
    setState({ kind: "idle" });
  }

  function retry() {
    if (lastSource.current) void start(lastSource.current);
  }

  function choose(toon: string) {
    if (state.kind === "identify") setState(recapState(state.rows, state.unreadable, toon));
  }

  return { state, start, clear, retry, choose };
}
