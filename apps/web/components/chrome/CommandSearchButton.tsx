"use client";

import { useRef } from "react";
import { Search } from "lucide-react";
import { useCommandSearch } from "./CommandSearchContext";

export function CommandSearchButton({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const search = useCommandSearch(), trigger = useRef<HTMLButtonElement>(null);
  if (!search) return null;
  return <button ref={trigger} type="button" aria-label="Search SC2 Tools" aria-haspopup="dialog"
    onClick={() => search.open({ returnFocus: trigger.current })}
    className={`min-h-11 items-center justify-center gap-2 rounded-full px-2 text-caption font-semibold text-text
      hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}>
    <Search className="h-4 w-4" aria-hidden />
    {!iconOnly ? <><span className="hidden xl:inline">Search</span>
      <kbd className="hidden rounded border border-border px-1 text-micro lg:inline">Ctrl/⌘ K</kbd></> : null}
  </button>;
}
