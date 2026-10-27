"use client";

import { useEffect, useRef } from "react";
import { SectionNav } from "@/components/ui/SectionNav";

const SECTIONS = [{ id: "overview", label: "Overview" }, { id: "battle-report", label: "Battle report" }, { id: "replay", label: "Replay" }, { id: "macro", label: "Macro" }, { id: "builds", label: "Builds" }];

/** Native anchors keep the player mounted while the page is being explored. */
export function GameWorkspaceNav() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nav = root.current?.querySelector("nav");
    const workspace = root.current?.closest<HTMLElement>("[data-game-workspace]");
    if (!nav || !workspace) return;
    const chrome = Array.from(document.querySelectorAll<HTMLElement>("header")).find((header) => header !== workspace.querySelector("header") && getComputedStyle(header).position === "sticky");
    const measure = () => {
      const top = chrome?.getBoundingClientRect().height || 0;
      nav.style.top = `${top}px`;
      workspace.style.setProperty("--game-section-offset", `${top + nav.getBoundingClientRect().height + 16}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(nav); if (chrome) observer?.observe(chrome);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return <div ref={root} className="contents"><SectionNav items={SECTIONS} aria-label="Game sections" variant="bar" data-tour="game-navigation" /></div>;
}
