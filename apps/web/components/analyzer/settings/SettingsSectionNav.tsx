"use client";

import { useEffect, useId, useState, type RefObject } from "react";
import type { SettingsSectionEntry } from "@/lib/settingsIndex";
import type { SettingsTabId } from "@/lib/settingsRegistry";
import { SECTION_WAIT_MS } from "./revealSectionAnchor";

type Props = {
  tab: SettingsTabId;
  sections: readonly SettingsSectionEntry[];
  scope: RefObject<HTMLElement | null>;
  hash: string;
  onNavigate: (href: string) => void;
};

/** Explicit selections use Shell admission. Observing the page only changes this nav. */
export function SettingsSectionNav({ tab, sections, scope, hash, onNavigate }: Props) {
  const labelId = useId();
  const requested = sections.find(section => `#${section.id}` === hash)?.id ?? sections[0]?.id ?? "";
  const [selected, setSelected] = useState(requested);
  useEffect(() => { setSelected(requested); }, [requested]);
  useEffect(() => {
    const root = scope.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const targets = new Map<Element, string>();
    const visible = new Map<Element, number>();
    const observer = new IntersectionObserver(entries => {
      if (!active) return;
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target, entry.boundingClientRect.top);
        else visible.delete(entry.target);
      }
      const nearest = [...visible].filter(([target]) => root.contains(target))
        .sort((a, b) => Math.abs(a[1] - 112) - Math.abs(b[1] - 112))[0];
      const id = nearest && targets.get(nearest[0]);
      if (id) setSelected(id);
    }, { rootMargin: "-112px 0px -55% 0px", threshold: 0 });
    const discover = () => {
      for (const [target] of targets) if (!root.contains(target)) {
        observer.unobserve(target); targets.delete(target); visible.delete(target);
      }
      const candidates = Array.from(root.querySelectorAll<HTMLElement>("[id]"));
      for (const section of sections) {
        // Query only this admitted column; chrome and inactive tabs never qualify.
        const target = candidates.find(element => element.id === section.id);
        if (target && !targets.has(target)) { targets.set(target, section.id); observer.observe(target); }
      }
    };
    discover();
    const mutations = new MutationObserver(discover);
    mutations.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => mutations.disconnect(), SECTION_WAIT_MS);
    return () => { active = false; window.clearTimeout(timeout); mutations.disconnect(); observer.disconnect(); };
  }, [scope, sections]);

  const hrefFor = (id: string) => {
    const query = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    query.set("tab", tab); query.delete("section"); query.delete("pack"); query.delete("widget");
    return `/settings?${query}#${id}`;
  };
  return <nav aria-label="On this page" className="min-w-0 lg:col-start-2 lg:row-start-1">
    <div className="lg:sticky lg:top-24">
      <label id={labelId} htmlFor={`${labelId}-select`} className="mb-2 block text-caption font-semibold text-text">On this page</label>
      <select id={`${labelId}-select`} aria-labelledby={labelId} value={selected} onChange={event => onNavigate(hrefFor(event.target.value))}
        className="min-h-11 w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden">
        {sections.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select>
      <ul className="hidden space-y-1 lg:block">{sections.map(section => <li key={section.id}>
        <a href={hrefFor(section.id)} aria-current={selected === section.id ? "location" : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onNavigate(hrefFor(section.id));
          }}
          className={`flex min-h-11 items-center rounded-md border px-3 py-2 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected === section.id ? "border-accent text-accent" : "border-transparent text-text-muted hover:bg-bg-elevated hover:text-text"}`}>
          {section.label}
        </a>
      </li>)}</ul>
    </div>
  </nav>;
}
