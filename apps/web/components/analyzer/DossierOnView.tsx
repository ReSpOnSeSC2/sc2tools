"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A single persistent reveal avoids mounting expensive sections before use. */
export function DossierOnView({ children, label }: { children: ReactNode; label: string }) {
  const host = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = host.current; if (!node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "100px" });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  return <div ref={host} className="min-w-0 max-w-full">{visible ? children : <div className="min-h-32 rounded-xl border border-border p-4 text-caption text-text-muted">{label} loads when you reach this section. <button type="button" className="min-h-11 px-2 text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setVisible(true)}>Load {label.toLowerCase()}</button></div>}</div>;
}
