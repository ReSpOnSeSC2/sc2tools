"use client";

import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from "react";
import { Button } from "@/components/ui/Button";
import type { MapPlayback } from "@/lib/mapReplay";
import type { PatchEra } from "@/lib/meta";

type LocalPlayerProps = { local: true; playback: MapPlayback; patchEra?: PatchEra | null };

type ReplayView =
  | { kind: "closed" }
  | { kind: "loading" | "empty" | "error"; source: unknown }
  | {
      kind: "ready";
      source: unknown;
      playback: MapPlayback;
      Player: ComponentType<LocalPlayerProps>;
    };

const CLOSED: ReplayView = { kind: "closed" };

function ReplayContents({ view, retry, patchEra }: {
  view: ReplayView;
  retry: () => void;
  patchEra?: PatchEra | null;
}) {
  switch (view.kind) {
    case "closed":
      return null;
    case "loading":
      return <div role="status" className="h-60 animate-pulse rounded-xl bg-bg-elevated p-4 text-text-muted motion-reduce:animate-none">Loading replay player…</div>;
    case "error":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-text-muted">
          The replay player could not load. <Button variant="secondary" onClick={retry}>Try again</Button>
        </div>
      );
    case "empty":
      return <p role="status" className="text-text-muted">This game has no playable local recording.</p>;
    case "ready":
      return (
        <div className="mx-auto w-full max-w-xl space-y-2">
          <p className="text-caption text-text-muted">Positions come from the replay file and may omit some movement.</p>
          <view.Player local playback={view.playback} patchEra={patchEra} />
        </div>
      );
  }
}

export function LocalReplayPanel({ data, patchEra }: { data: unknown; patchEra?: PatchEra | null }) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const loadId = useRef(0);
  const [view, setView] = useState<ReplayView>(CLOSED);
  const current = view.kind !== "closed" && view.source === data ? view : CLOSED;
  useEffect(() => () => { loadId.current += 1; }, []);

  async function open() {
    const request = ++loadId.current;
    setView({ kind: "loading", source: data });
    try {
      const [{ CompactReplayHost }, { sanitizeMapPlayback }] = await Promise.all([
        import("@/components/analyzer/game/replay/CompactReplayHost"),
        import("@/lib/mapReplay"),
      ]);
      if (loadId.current !== request) return;
      const playback = sanitizeMapPlayback(data);
      setView(playback
        ? { kind: "ready", source: data, playback, Player: CompactReplayHost }
        : { kind: "empty", source: data });
    } catch {
      if (loadId.current === request) setView({ kind: "error", source: data });
    }
  }

  const close = useCallback(() => {
    loadId.current += 1;
    setView(CLOSED);
    trigger.current?.focus();
  }, []);

  const expanded = current.kind !== "closed";
  function retry() {
    trigger.current?.focus();
    void open();
  }

  useEffect(() => {
    const element = panel.current;
    if (!expanded || !element) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.fullscreenElement) return;
      event.preventDefault();
      close();
    }
    element.addEventListener("keydown", dismiss);
    return () => element.removeEventListener("keydown", dismiss);
  }, [expanded, close]);

  return (
    <section ref={panel} aria-label="Local replay" className="min-w-0 space-y-3">
      <Button ref={trigger} variant="secondary" aria-expanded={expanded} aria-controls={id} onClick={() => expanded ? close() : void open()}>
        {expanded ? "Close replay" : "Watch this game"}
      </Button>
      <div id={id} hidden={!expanded}>
        <ReplayContents view={current} retry={retry} patchEra={patchEra} />
      </div>
    </section>
  );
}
