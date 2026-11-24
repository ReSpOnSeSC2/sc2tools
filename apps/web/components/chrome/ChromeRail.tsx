"use client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { NavEntry } from "./appNav";
export function RailLabel({ children }: { children: ReactNode }) {
  return <span className="app-rail-label whitespace-nowrap font-display text-caption font-semibold opacity-0 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">{children}</span>;
}
export function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div role="group" aria-labelledby={id}><p id={id} className="app-rail-caption text-micro font-semibold uppercase tracking-[0.14em] text-text-dim">{label}</p>{children}</div>;
}
export function RailLink({ entry, active, pinned, onNavigate }: { entry: NavEntry; active: boolean; pinned: boolean; onNavigate: () => void }) {
  const Icon = entry.icon; const id = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [tooltip, setTooltip] = useState({ active: false, top: 0 });
  const show = (element: HTMLElement) => setTooltip({ active: true, top: Math.max(8, element.getBoundingClientRect().top) });
  const hide = () => setTooltip((value) => ({ ...value, active: false }));
  return <><Link href={entry.href} prefetch={entry.ownChrome ? false : undefined} onNavigate={onNavigate} aria-current={active ? "page" : undefined} aria-describedby={pinned ? undefined : id}
    onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={hide} onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget); }} onBlur={hide}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); hide(); } }}
    className={`relative flex h-10 items-center gap-3 rounded-xl border border-transparent px-2.5 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "bg-accent-cyan/10 text-text" : "text-text-muted hover:bg-bg-subtle/70 hover:text-text"}`}>
    {active ? <span aria-hidden className="aurora-beam pointer-events-none absolute -left-2 top-2 bottom-2 w-0.5 rounded-full" /> : null}
    <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-accent-cyan" : ""}`} aria-hidden /><RailLabel>{entry.label}</RailLabel>
  </Link>{mounted && !pinned && typeof document !== "undefined" ? createPortal(<div id={id} role="tooltip" className="pointer-events-none fixed left-[232px] z-[100] max-w-xs rounded-xl border border-line glass-strong p-3 text-caption text-text shadow-pop" style={{ top: tooltip.top, opacity: tooltip.active ? 1 : 0, visibility: tooltip.active ? "visible" : "hidden", transitionProperty: "visibility, opacity", transitionDuration: "0ms", transitionDelay: tooltip.active ? "300ms" : "0ms" }}><p className="font-semibold">{entry.label}</p>{entry.description ? <p className="text-text-muted">{entry.description}</p> : null}</div>, document.body) : null}</>;
}
