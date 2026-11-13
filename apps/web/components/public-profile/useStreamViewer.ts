"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { parseStreamViewer, type StreamViewerPage } from "@/lib/streamViewer";
import { streamViewerApiPath } from "@/lib/streamViewerRoute";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const POLL_MS = 60_000;
const DEADLINE_MS = 8_000;
type State = { kind: "ready"; page: StreamViewerPage } | { kind: "loading" | "missing" | "error" };

async function latest(url: string, signal: AbortSignal): Promise<State> {
  const response = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    signal, headers: { accept: "application/json" } });
  if (response.status === 404) return { kind: "missing" };
  const page = response.ok ? parseStreamViewer(await response.json()) : null;
  return page ? { kind: "ready", page } : { kind: "error" };
}

export function useStreamViewer(handle: string) {
  // Next can restore the page from its router cache. The cached tree carries
  // only the loading state until the API has checked publication again.
  const [state, setState] = useState<State>({ kind: "loading" });
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | null = null;
    const visible = () => document.visibilityState === "visible";
    const url = `${API_BASE}${streamViewerApiPath(handle)}`;

    function pause() {
      clearTimeout(timer);
      const request = pending;
      pending = null;
      request?.abort();
    }
    function schedule() {
      clearTimeout(timer);
      if (visible()) timer = setTimeout(() => void refresh(false), POLL_MS);
    }
    async function refresh(loading: boolean) {
      if (!visible() || pending) return;
      clearTimeout(timer);
      const request = new AbortController();
      pending = request;
      if (loading) setState({ kind: "loading" });
      const deadline = setTimeout(() => request.abort(), DEADLINE_MS);
      try {
        const next = await latest(url, request.signal);
        if (pending === request && visible()) setState(next);
      } catch {
        if (pending === request && visible()) setState({ kind: "error" });
      } finally {
        clearTimeout(deadline);
        if (pending === request) { pending = null; schedule(); }
      }
    }
    const onVisibility = () => { if (visible()) void refresh(true); else pause(); };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) { pause(); onVisibility(); }
    };
    const onPageHide = () => {
      pause();
      flushSync(() => setState({ kind: "loading" }));
    };
    retry.current = () => void refresh(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    void refresh(false);
    return () => {
      pause(); retry.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [handle]);

  return { state, refresh: () => retry.current?.() };
}
