"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { DockCopyText } from "./DockCopyText";
import { DockButton, DockToggle } from "./DockControls";

type Chapters = { lines: string[]; message: string };

/** Reads the per-game chapter lines for the stream the Dock marked; one fetch per press. */
function useGameChapters(token: string) {
  const [state, setState] = useState<{ token: string; chapters: Chapters | null; loading: boolean; error: boolean }>({ token, chapters: null, loading: false, error: false });
  const pending = useRef<AbortController | null>(null);
  const current = state.token === token ? state : { token, chapters: null, loading: false, error: false };
  useEffect(() => () => pending.current?.abort(), [token]);
  async function load() {
    if (!token || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ token, chapters: null, loading: true, error: false });
    try {
      const response = await fetch(`${API_BASE}/v1/multichat/${encodeURIComponent(token)}/chapters`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("load_failed");
      const body = await response.json() as { lines?: unknown; message?: unknown };
      if (controller.signal.aborted) return;
      const lines = Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === "string").slice(0, 400) : [];
      setState({ token, chapters: { lines, message: typeof body.message === "string" ? body.message.slice(0, 300) : "" }, loading: false, error: false });
    } catch {
      if (!controller.signal.aborted) setState({ token, chapters: null, loading: false, error: true });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  return { ...current, load };
}

/**
 * Game chapters for the stream's video: the YouTube switch and the same list as
 * text for a Twitch or Kick description.
 */
export function DockGameChapters({ token, enabled, youtube, busy, onToggleYoutube }: {
  token: string; enabled: boolean; youtube: boolean; busy: boolean; onToggleYoutube: (next: boolean) => void;
}) {
  const chapters = useGameChapters(token);
  return <div className="space-y-1.5" aria-label="Game chapters" role="group">
    <div className="flex items-center gap-2">
      <DockToggle checked={youtube} disabled={busy || !enabled} onChange={onToggleYoutube} label="Add game chapters to the YouTube archive at End stream" />
      <span className="min-w-0 flex-1 text-caption text-text">Add game chapters to the YouTube archive at End stream</span>
    </div>
    <p className="text-micro text-text-muted">Off by default. Only the marked block of the description changes; your own text stays.</p>
    <div className="flex flex-wrap items-center gap-2">
      <DockButton disabled={!enabled || chapters.loading} onClick={() => void chapters.load()}>Show game chapters</DockButton>
      {chapters.chapters && chapters.chapters.lines.length > 0 ? <DockCopyText value={chapters.chapters.lines.join("\n")} label="Copy game chapters" /> : null}
    </div>
    {chapters.loading ? <p role="status" className="text-caption text-text-muted">Loading game chapters…</p> : null}
    {chapters.error ? <p role="alert" className="text-caption text-danger">Couldn’t load game chapters. <DockButton onClick={() => void chapters.load()}>Retry</DockButton></p> : null}
    {chapters.chapters?.message ? <p role="status" className="text-caption text-text-muted">{chapters.chapters.message}</p> : null}
    {chapters.chapters && chapters.chapters.lines.length > 0 ? <ul className="max-h-40 space-y-0.5 overflow-y-auto text-micro tabular-nums text-text">
      {chapters.chapters.lines.map((line) => <li key={line} className="break-words">{line}</li>)}
    </ul> : null}
  </div>;
}
