"use client";
import { useEffect, useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import { GameControlActions } from "../replays/GameControlActions";
import type { ReplayControlChange, ReplayControlTarget } from "@/lib/replayGameControls";

export function GameDataMenu({ game, onComplete }: { game: ReplayControlTarget; onComplete: (changes: ReplayControlChange[]) => void | Promise<void> }) {
  const menu = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <div className="flex flex-wrap items-center gap-2">{game.excluded ? <span role="status" className="text-caption text-warning">Hidden from stats</span> : null}<details ref={menu} className="relative" onKeyDown={event => { if (event.key === "Escape" && menu.current?.open) { event.stopPropagation(); menu.current.open = false; trigger.current?.focus(); } }}>
    <summary ref={trigger} aria-label="More game actions" className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" aria-hidden /></summary>
    <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-bg-surface p-2 shadow-lg"><GameControlActions targets={[game]} scopeKey={`game:${game.gameId}`} menu onOpening={() => { if (menu.current) menu.current.open = false; trigger.current?.focus(); }} onComplete={onComplete} /></div>
  </details></div>;
}
