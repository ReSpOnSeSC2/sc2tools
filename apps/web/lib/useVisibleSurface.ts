"use client";
import { useEffect, useState, type RefObject } from "react";
/** Visibility gates polling; it does not change any account or source state. */
export function useVisibleSurface(host: RefObject<HTMLElement | null>, enabled = true) {
  const [inView, setInView] = useState(false), [pageVisible, setPageVisible] = useState(false);
  useEffect(() => {
    const visibility = () => setPageVisible(!document.hidden); visibility();
    document.addEventListener("visibilitychange", visibility); return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!enabled || !host.current) { setInView(false); return; }
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const observer = new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)));
    observer.observe(host.current); return () => observer.disconnect();
  }, [enabled, host]);
  return enabled && inView && pageVisible;
}
