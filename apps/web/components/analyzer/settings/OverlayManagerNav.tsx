"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { OVERLAY_PANES, resolveSettingsDestination } from "@/lib/settingsRegistry";

export const OVERLAY_SECTIONS = [
  ["setup", "Setup"], ["widgets", "Widgets"], ["look", "Look"],
  ["scenes", "Scenes"], ["tokens", "Tokens"],
] as const;
export type OverlaySection = typeof OVERLAY_SECTIONS[number][0];
export function useOverlaySection(): OverlaySection {
  const query = useSearchParams(), requested = query.get("section");
  const [hash, setHash] = useState("");
  useEffect(() => { const update = () => setHash(location.hash); update(); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); }, []);
  if (OVERLAY_PANES.some(id => id === requested)) return requested as OverlaySection;
  return resolveSettingsDestination(query.toString(), hash, "overlay").overlayPane;
}
export function OverlayManagerNav({ section }: { section: OverlaySection }) {
  const query = useSearchParams();
  return <nav aria-label="Overlay settings sections" className="sticky top-16 z-20 -mx-1 flex max-w-full gap-1 overflow-x-auto border-y border-border bg-bg-surface/95 px-1 py-2 backdrop-blur">{OVERLAY_SECTIONS.map(([id, label]) => {
    const next = new URLSearchParams(query.toString()); next.set("tab", "overlay"); next.set("section", id); next.delete("pack"); next.delete("widget");
    return <Link key={id} href={`/settings?${next}`} scroll={false} aria-current={section === id ? "page" : undefined} className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${section === id ? "border-accent text-accent" : "border-border text-text-muted"}`}>{label}</Link>;
  })}</nav>;
}
