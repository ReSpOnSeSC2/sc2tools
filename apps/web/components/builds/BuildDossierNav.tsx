"use client";

import { useEffect, useMemo, useState } from "react";

const SECTIONS = [{ id: "overview", label: "Overview" }, { id: "army", label: "Army" }, { id: "matchups", label: "Matchups & maps" }, { id: "games", label: "Games" }];

/** Full-page dossier links remain native anchors and fit a phone in one scrollable row. */
export function BuildDossierNav({ insights = false, plan = false }: { insights?: boolean; plan?: boolean }) {
  const [active, setActive] = useState("overview");
  const sections = useMemo(() => [SECTIONS[0], ...(insights ? [{ id: "timings", label: "Key timings" }] : []), ...(plan ? [{ id: "plan", label: "Plan survival" }] : []), ...SECTIONS.slice(1)], [insights, plan]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (sections.some(({ id }) => id === hash)) setActive(hash);
    else setActive(current => sections.some(({ id }) => id === current) ? current : "overview");
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top); else visible.delete(entry.target.id); });
      const nearest = [...visible].sort((a, b) => Math.abs(a[1] - 100) - Math.abs(b[1] - 100))[0];
      if (nearest) setActive(nearest[0]);
    }, { rootMargin: "-90px 0px -55% 0px" });
    sections.forEach(({ id }) => { const section = document.getElementById(id); if (section) observer.observe(section); });
    return () => observer.disconnect();
  }, [sections]);
  return <nav aria-label="Build sections" className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 flex gap-2 overflow-x-auto border-y border-border bg-bg/95 py-1 sm:top-[calc(4rem+env(safe-area-inset-top))]">
    {sections.map(({ id, label }) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} onClick={() => setActive(id)} className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === id ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>{label}</a>)}
  </nav>;
}
