"use client";

import { useEffect, useRef, useState } from "react";
import type { StudioState } from "@/lib/multichat/useStudioState";
import type { DockPost } from "./dockActions";

type DockAction = { patch: Record<string, unknown>; message: string; after?: (saved: StudioState) => void; retry?: () => Promise<StudioState | null> };
type ActionFactory = (...args: never[]) => DockAction | null;

/** Retry invokes the latest render's factory, so newer form edits stay authoritative. */
export function useDockPanelActions<A extends Record<string, ActionFactory>>(ready: boolean, busy: boolean, onPost: DockPost, actions: A) {
  const latest = useRef({ ready, busy, onPost, actions });
  latest.current = { ready, busy, onPost, actions };
  const active = useRef(true);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function run<K extends keyof A>(name: K, ...args: Parameters<A[K]>): Promise<StudioState | null> {
    const current = latest.current;
    if (!active.current || !current.ready || current.busy || inFlight.current) return null;
    const action = current.actions[name](...args);
    if (!action) return null;
    inFlight.current = true;
    setPending(true);
    setNotice("");
    try {
      const saved = await current.onPost(action.patch, action.retry ?? (() => run(name, ...args)));
      if (saved && active.current) { action.after?.(saved); setNotice(action.message); }
      return saved;
    } finally { inFlight.current = false; if (active.current) setPending(false); }
  }
  return { run, notice, pending };
}

export function DockSnapshotState() {
  const [late, setLate] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setLate(true), 15_000); return () => clearTimeout(timer); }, []);
  return <div role="status" className="space-y-2 text-caption text-text-muted"><div aria-hidden className="h-10 rounded bg-bg-elevated motion-safe:animate-pulse" />{late ? "Still loading your saved controls — retrying…" : "Loading your saved controls…"}</div>;
}

export function DockActionNotice({ message }: { message: string }) {
  if (!message) return null;
  return <p role="status" className="text-caption text-success">{message}</p>;
}
