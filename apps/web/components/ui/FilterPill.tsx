"use client";

import type { ButtonHTMLAttributes } from "react";

/** A pressed filter with a full 44px touch target. */
export function FilterPill({ active, className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return <button {...props} type="button" aria-pressed={active} className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 py-2 text-caption font-medium transition-[color,background-color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "border-accent-cyan/40 bg-accent-cyan/10 text-accent" : "border-line bg-bg-elevated/60 text-text-muted hover:border-border-strong hover:text-text"} ${className}`}>{children}</button>;
}
