"use client";
import { useEffect, useState } from "react";
import { BookOpen, Compass, Layers3, Wrench } from "lucide-react";
const SECTIONS = [
  { id: "crash-course", label: "Crash course", icon: BookOpen },
  { id: "starter-setups", label: "Starter setups", icon: Layers3 },
  { id: "widget-library", label: "Widget guide", icon: Compass },
  { id: "troubleshooting", label: "Fix a problem", icon: Wrench },
];
export function LearnSectionNav() {
  const [active, setActive] = useState("crash-course");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      const positions = [...visible].map((target) => ({ id: target.id, top: target.getBoundingClientRect().top }));
      // Subpixel section boundaries can leave a sliver of the preceding section
      // intersecting after an anchor jump. Prefer the latest heading at the
      // shared offset, with two pixels for browser rounding.
      const current = positions.filter((item) => item.top <= 114).sort((a, b) => b.top - a.top)[0]
        ?? positions.sort((a, b) => a.top - b.top)[0];
      if (current) setActive(current.id);
    }, { rootMargin: "-112px 0px -55% 0px", threshold: 0 });
    for (const { id } of SECTIONS) { const section = document.getElementById(id); if (section) observer.observe(section); }
    return () => observer.disconnect();
  }, []);
  return <nav aria-label="Learning sections" className="sticky top-16 z-20 flex gap-1 overflow-x-auto rounded-md border-2 border-line bg-bg px-2 py-1 shadow-sm sm:gap-3">
    {SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-current={active === id ? "true" : undefined} onClick={() => setActive(id)}
      className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full px-2 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === id ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-elevated hover:text-accent"}`}><Icon className="h-4 w-4" aria-hidden />{label}</a>)}
  </nav>;
}
