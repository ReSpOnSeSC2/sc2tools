"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { SETTINGS_SECTIONS_READY_EVENT, type SettingsSectionEntry } from "@/lib/settingsIndex";
import type { SettingsTabId } from "@/lib/settingsRegistry";
import { SECTION_WAIT_MS } from "./revealSectionAnchor";

type Props = {
  tab: SettingsTabId;
  sections: readonly SettingsSectionEntry[];
  scope: RefObject<HTMLElement | null>;
  hash: string;
  onNavigate: (href: string) => void;
  targetPolicy?: "catalog" | "mounted";
  minimumSections?: number;
};

/** A no-payload local readiness signal. Its stable revision never follows draft
 * text, polling payloads or private values. Only the admitted body can emit it. */
export function SettingsSectionsReady({ revision = "ready" }: { revision?: string | boolean }) {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    marker.current?.dispatchEvent(new Event(SETTINGS_SECTIONS_READY_EVENT, { bubbles: true }));
  }, [revision]);
  return <span ref={marker} hidden aria-hidden="true" />;
}

/** Explicit selections use Shell admission. Observing the page only changes this nav. */
export function SettingsSectionNav({ tab, sections, scope, hash, onNavigate, targetPolicy = "catalog", minimumSections = 1 }: Props) {
  const labelId = useId();
  const requested = sections.find(section => `#${section.id}` === hash)?.id ?? sections[0]?.id ?? "";
  const [selected, setSelected] = useState(requested);
  const [present, setPresent] = useState<readonly string[]>([]);
  useEffect(() => { setSelected(requested); }, [requested]);
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    let active = true;
    let mutations: MutationObserver | null = null;
    let timeout: number | undefined;
    let discoveryWindow = 0;
    let frame: number | undefined;
    const targets = new Map<Element, string>();
    const visible = new Set<Element>();
    const selectVisible = () => {
      if (!active || !root.isConnected) return;
      const nearest = [...visible].filter(target => target.isConnected && root.contains(target))
        .map(target => ({ target, top: target.getBoundingClientRect().top }))
        .sort((a, b) => Math.abs(a.top - 112) - Math.abs(b.top - 112))[0];
      const id = nearest && targets.get(nearest.target);
      if (id) setSelected(id);
    };
    const scheduleSelection = () => {
      if (!active || frame !== undefined) return;
      frame = window.requestAnimationFrame(() => { frame = undefined; selectVisible(); });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (!active || !root.isConnected) return;
      for (const entry of entries) {
        if (!targets.has(entry.target) || !root.contains(entry.target)) continue;
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      selectVisible();
    }, { rootMargin: "-112px 0px -55% 0px", threshold: 0 });
    const discover = () => {
      if (!active || !root.isConnected) return;
      for (const [target] of targets) if (!root.contains(target)) {
        observer?.unobserve(target); targets.delete(target); visible.delete(target);
      }
      const candidates = Array.from(root.querySelectorAll<HTMLElement>("[id]"));
      for (const section of sections) {
        // Query only this admitted column; chrome and inactive tabs never qualify.
        const target = candidates.find(element => element.id === section.id);
        if (target && !targets.has(target)) { targets.set(target, section.id); observer?.observe(target); }
      }
      if (targetPolicy === "mounted") {
        const next = sections.filter(section => candidates.some(element => element.id === section.id)).map(section => section.id);
        setPresent(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
      }
    };
    const arm = () => {
      if (!active || !root.isConnected) return;
      const currentWindow = ++discoveryWindow;
      mutations?.disconnect(); window.clearTimeout(timeout);
      discover();
      mutations = new MutationObserver(() => { if (currentWindow === discoveryWindow) discover(); });
      mutations.observe(root, { childList: true, subtree: true });
      timeout = window.setTimeout(() => { if (currentWindow === discoveryWindow) mutations?.disconnect(); }, SECTION_WAIT_MS);
    };
    const ready = (event: Event) => {
      if (event.target instanceof Node && root.contains(event.target)) arm();
    };
    arm();
    window.addEventListener("scroll", scheduleSelection, { passive: true, capture: true });
    window.addEventListener("resize", scheduleSelection, { passive: true });
    if (targetPolicy === "mounted") root.addEventListener(SETTINGS_SECTIONS_READY_EVENT, ready);
    return () => {
      active = false; discoveryWindow++; window.clearTimeout(timeout); mutations?.disconnect(); observer?.disconnect();
      window.removeEventListener("scroll", scheduleSelection, true);
      window.removeEventListener("resize", scheduleSelection);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      root.removeEventListener(SETTINGS_SECTIONS_READY_EVENT, ready);
    };
  }, [scope, sections, targetPolicy]);

  const options = targetPolicy === "mounted" ? sections.filter(section => present.includes(section.id)) : sections;
  const current = options.some(section => section.id === selected) ? selected
    : options.find(section => section.id === requested)?.id ?? options[0]?.id ?? "";

  const hrefFor = (id: string) => {
    const query = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    query.set("tab", tab); query.delete("section"); query.delete("pack"); query.delete("widget");
    return `/settings?${query}#${id}`;
  };
  if (options.length < minimumSections) return null;
  return <nav aria-label="On this page" className="min-w-0 lg:col-start-2 lg:row-start-1">
    <div className="lg:sticky lg:top-24">
      <label id={labelId} htmlFor={`${labelId}-select`} className="mb-2 block text-caption font-semibold text-text">On this page</label>
      <select id={`${labelId}-select`} aria-labelledby={labelId} value={current} onChange={event => onNavigate(hrefFor(event.target.value))}
        className="min-h-11 w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden">
        {options.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select>
      <ul className="hidden space-y-1 lg:block">{options.map(section => <li key={section.id}>
        <a href={hrefFor(section.id)} aria-current={current === section.id ? "location" : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onNavigate(hrefFor(section.id));
          }}
          className={`flex min-h-11 items-center rounded-md border px-3 py-2 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${current === section.id ? "border-accent text-accent" : "border-transparent text-text-muted hover:bg-bg-elevated hover:text-text"}`}>
          {section.label}
        </a>
      </li>)}</ul>
    </div>
  </nav>;
}
