"use client";

import { useEffect, useRef, useState } from "react";
import { revealHorizontally } from "@/lib/a11y/revealHorizontally";

export interface SectionNavItem { id: string; label: string }
export interface SectionNavProps { items: readonly SectionNavItem[]; "aria-label"?: string; "data-tour"?: string; variant?: "rail" | "bar" }

/** Scroll-spy links shared by long reading surfaces. Native hashes work without JS. */
export function SectionNav({ items, "aria-label": label = "On this page", "data-tour": tourTarget, variant = "rail" }: SectionNavProps) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const [edges, setEdges] = useState({ left: false, right: false });
  const scroller = useRef<HTMLDivElement>(null);
  const encodedItems = JSON.stringify(items);
  useEffect(() => {
    const sections = (JSON.parse(encodedItems) as SectionNavItem[]).map((item) => document.getElementById(item.id)).filter((node): node is HTMLElement => Boolean(node));
    let hash = window.location.hash.slice(1);
    try { hash = decodeURIComponent(hash); } catch { /* A malformed incoming hash is just unmatched. */ }
    if (sections.some((node) => node.id === hash)) setActive(hash);
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      const next = [...visible].sort((a, b) => Math.abs(a[1] - 120) - Math.abs(b[1] - 120))[0];
      if (next) setActive(next[0]);
    }, { rootMargin: "-120px 0px -60% 0px" });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [encodedItems]);
  const measure = () => {
    const el = scroller.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    measure(); const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el); return () => observer?.disconnect();
  }, [encodedItems]);
  useEffect(() => {
    const el = scroller.current;
    const chip = el?.querySelector<HTMLElement>('[aria-current]');
    // Scroll-spy updates may reveal a chip, never move the reading position.
    if (el && chip) revealHorizontally(el, chip);
  }, [active]);
  return <nav aria-label={label} data-tour={tourTarget} className={`sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 min-w-0 self-start border-y border-border bg-bg/95 py-0.5 supports-[backdrop-filter]:backdrop-blur-sm sm:top-[calc(4rem+env(safe-area-inset-top))] print:hidden ${variant === "rail" ? "lg:col-start-2 lg:row-start-1 lg:top-24 lg:border-0 lg:bg-transparent" : ""}`}>
    <h2 className={`sr-only mb-2 text-caption font-semibold ${variant === "rail" ? "lg:not-sr-only" : ""}`}>{label}</h2>
    <div className="relative"><div ref={scroller} onScroll={measure} className={`flex gap-2 overflow-x-auto ${variant === "rail" ? "lg:block lg:space-y-1 lg:overflow-visible" : ""}`}>
      {items.map((item) => <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? variant === "bar" ? "true" : "location" : undefined} onClick={(event) => {
        const target = document.getElementById(item.id); if (!target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); setActive(item.id);
        target.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        const url = new URL(window.location.href); url.hash = item.id; window.history.replaceState(window.history.state, "", url);
      }} className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 py-2 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${variant === "rail" ? "lg:flex lg:rounded-md" : ""} ${active === item.id ? "border-accent/40 bg-accent/10 text-accent" : `border-border text-text-muted hover:text-text ${variant === "rail" ? "lg:border-transparent" : ""}`}`}>{item.label}</a>)}
    </div>{edges.left ? <span aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 w-5 bg-gradient-to-r from-bg to-transparent ${variant === "rail" ? "lg:hidden" : ""}`} /> : null}{edges.right ? <span aria-hidden className={`pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-bg to-transparent ${variant === "rail" ? "lg:hidden" : ""}`} /> : null}</div>
  </nav>;
}
