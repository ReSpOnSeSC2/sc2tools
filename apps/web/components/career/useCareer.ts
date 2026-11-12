"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { careerRecord, type CareerRecord } from "@/lib/career/careerRecord";
import type { CareerProgress, CareerScan } from "@/lib/career/careerScan";
import { headerIdentity, selectedGamesFromHeaders } from "@/lib/career/headerRows";
import type { MeCandidate } from "@/lib/instant/meDetection";
import type { IntakeFile, ReplaySource } from "@/lib/instant/types";

type ScanSummary = Omit<CareerScan, "rows">;
type ClearState = "idle" | "clearing" | "cleared" | "unavailable";

export type CareerState =
  | { kind: "idle" }
  | ({ kind: "scanning" } & CareerProgress)
  | { kind: "empty"; reason: "files" | "ladder" | "player" }
  | { kind: "error" }
  | { kind: "identify"; scan: CareerScan; candidates: MeCandidate[] }
  | ({ kind: "record"; record: CareerRecord } & ScanSummary);

function results({ rows, ...scan }: CareerScan, toon?: string): CareerState {
  const record = careerRecord(selectedGamesFromHeaders(rows, toon));
  return record ? { kind: "record", record, ...scan } : { kind: "empty", reason: "player" };
}

function resolveScan(scan: CareerScan | null): CareerState {
  if (!scan) return { kind: "empty", reason: "files" };
  if (!scan.rows.length) return { kind: "empty", reason: "ladder" };
  const identity = headerIdentity(scan.rows);
  return identity.needsConfirmation
    ? { kind: "identify", scan, candidates: identity.candidates }
    : results(scan);
}

export function useCareer() {
  const [state, setState] = useState<CareerState>({ kind: "idle" });
  const [clearState, setClearState] = useState<ClearState>("idle");
  const active = useRef<AbortController | null>(null);
  const lastSource = useRef<ReplaySource | null>(null);
  const clearing = useRef(false);
  useEffect(() => () => active.current?.abort(), []);

  async function start(source: ReplaySource) {
    if (active.current || clearing.current) return;
    lastSource.current = source;
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    setState({ kind: "scanning", phase: "files", complete: 0, total: 0 });
    setClearState("idle");
    try {
      const files = await source(signal);
      signal.throwIfAborted();
      const next = files ? await runScan(files, signal) : { kind: "idle" } as const;
      signal.throwIfAborted();
      lastSource.current = null;
      setState(next);
    } catch {
      if (!signal.aborted) setState({ kind: "error" });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function runScan(files: IntakeFile[], signal: AbortSignal) {
    const { scanCareer } = await import("@/lib/career/careerScan");
    signal.throwIfAborted();
    return resolveScan(await scanCareer(files, {
      signal,
      onProgress: (progress) => setState({ kind: "scanning", ...progress }),
    }));
  }

  const reset = useCallback(() => {
    active.current?.abort();
    active.current = null;
    lastSource.current = null;
    setState({ kind: "idle" });
  }, []);

  async function forget() {
    if (clearing.current) return;
    clearing.current = true;
    reset();
    setClearState("clearing");
    try {
      const { clearCareerCache } = await import("@/lib/career/careerCache");
      setClearState(await clearCareerCache() ? "cleared" : "unavailable");
    } catch {
      setClearState("unavailable");
    } finally {
      clearing.current = false;
    }
  }

  return {
    state, clearState, start, reset, forget,
    retry: () => { if (lastSource.current) void start(lastSource.current); },
    choose: (toon: string) => { if (state.kind === "identify") setState(results(state.scan, toon)); },
  };
}
