"use client";

import { useRef } from "react";
import { Search } from "lucide-react";
import { useCommandSearch } from "./CommandSearchContext";

export function CommandSearchButton({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const search = useCommandSearch(), trigger = useRef<HTMLButtonElement>(null);
  if (!search) return null;
  return <button ref={trigger} type="button" aria-label="Search SC2 Tools" aria-haspopup="dialog"
    onClick={() => search.open({ returnFocus: trigger.current })}
    className={`min-h-11 items-center justify-center gap-2 rounded-full text-caption font-medium motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${iconOnly
      ? "w-11 text-text-muted hover:bg-bg-subtle hover:text-text"
      : "border border-line bg-bg-elevated/60 px-3 text-text-muted hover:border-border-strong hover:text-text lg:min-h-10 lg:min-w-[15rem] lg:justify-start xl:min-w-[20rem]"} ${className}`}>
    <Search className="h-4 w-4 shrink-0" aria-hidden />
    {!iconOnly ? <><span className="hidden lg:inline">Search or jump to…</span><span className="hidden lg:inline-flex lg:flex-1" aria-hidden />
      <kbd className="hidden rounded-md border border-line bg-bg-subtle px-1.5 font-sans text-micro text-text-dim lg:inline">Ctrl/⌘ K</kbd></> : null}
  </button>;
}
