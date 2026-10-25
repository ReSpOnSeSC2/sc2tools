"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DOCK_SECTIONS, type DockSectionId } from "@/lib/dockLayout";

/** Observe section headers in the viewport, including folded sections. */
export function useDockScrollSpy(expand: (id: DockSectionId, open: boolean) => void) {
  const [active, setActive] = useState<DockSectionId>("dock-chat");
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<DockSectionId, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = entry.target.getAttribute("data-dock-section") as DockSectionId;
        if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
        else visible.delete(id);
      }
      const first = [...visible].sort((a, b) => a[1] - b[1])[0];
      if (first) setActive(first[0]);
    }, { rootMargin: "-64px 0px -60% 0px", threshold: 0 });
    for (const section of DOCK_SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const jumpTo = useCallback((id: DockSectionId) => {
    expand(id, true); setActive(id);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
      document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true });
    });
  }, [expand]);
  return { active, jumpTo };
}
