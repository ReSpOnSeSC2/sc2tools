"use client";
import { Star } from "lucide-react";
export function RivalStar({ name, starred, disabled, onToggle }: { name: string; starred: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={`${starred ? "Unstar" : "Star"} ${name}`} aria-pressed={starred} disabled={disabled} onClick={event => { event.stopPropagation(); onToggle(); }} className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${starred ? "text-warning" : "text-text-dim hover:text-warning"}`}><Star className="h-4 w-4" fill={starred ? "currentColor" : "none"} aria-hidden /></button>;
}
