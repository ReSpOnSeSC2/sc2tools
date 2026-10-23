"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { sharedAnalysisHref } from "./archiveQuery";

export function ReplayNeighborNav({ root, from, neighbors }: { root: string; from?: string; neighbors: PublicReplayDetailResponse["neighbors"] }) {
  const router = useRouter();
  const older = neighbors?.olderGameId ? sharedAnalysisHref(root, neighbors.olderGameId, from) : undefined;
  const newer = neighbors?.newerGameId ? sharedAnalysisHref(root, neighbors.newerGameId, from) : undefined;
  useEffect(() => {
    if (!older && !newer) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,dialog,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"],[role="combobox"],[data-testid="interactive-timeline"]')) return;
      const href = event.key === "ArrowLeft" ? older : event.key === "ArrowRight" ? newer : undefined;
      if (href) { event.preventDefault(); router.push(href); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [older, newer, router]);
  if (!older && !newer) return null;
  const className = buttonClassName({ variant: "secondary", size: "sm", className: "min-h-11" });
  return <nav aria-label="Neighboring replays" className="flex flex-wrap items-center gap-2">
    {older ? <Link href={older} className={className}><ChevronLeft className="h-4 w-4" aria-hidden />Older game</Link> : <span aria-disabled="true" title="This is the oldest game in this list" className={`${className} opacity-50`}><ChevronLeft className="h-4 w-4" aria-hidden />Older game</span>}
    {newer ? <Link href={newer} className={className}>Newer game<ChevronRight className="h-4 w-4" aria-hidden /></Link> : <span aria-disabled="true" title="This is the newest game in this list" className={`${className} opacity-50`}>Newer game<ChevronRight className="h-4 w-4" aria-hidden /></span>}
    <span className="hidden text-micro text-text-muted [@media(hover:hover)]:inline">Tip: ← / → moves between games</span>
  </nav>;
}
