"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const EVENT = "sc2tools:navigation-start";
export function startNavProgress() { window.dispatchEvent(new Event(EVENT)); }
/** Delayed, indeterminate route feedback. The safety timer also handles cancelled navigation. */
export function NavProgress({ onPendingChange }: { onPendingChange?: (pending: boolean) => void }) {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const [shown, setShown] = useState(false);
  const [complete, setComplete] = useState(false);
  const [width, setWidth] = useState(15);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const pending = useRef(false);
  useEffect(() => {
    function clear() { timers.current.forEach(clearTimeout); timers.current = []; }
    const start = () => {
      clear(); pending.current = true; setComplete(false); setWidth(15); onPendingChange?.(true);
      timers.current.push(setTimeout(() => {
        setShown(true);
        // Give the mounted bar a paint at its starting width before easing forward.
        timers.current.push(setTimeout(() => setWidth(80), 20));
      }, 150));
      timers.current.push(setTimeout(() => { pending.current = false; setShown(false); onPendingChange?.(false); }, 15000));
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || link.hasAttribute("data-no-progress") || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname + url.search === window.location.pathname + window.location.search) return;
      start();
    };
    document.addEventListener("click", click); window.addEventListener(EVENT, start);
    return () => { clear(); document.removeEventListener("click", click); window.removeEventListener(EVENT, start); };
  }, [onPendingChange]);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false; timers.current.forEach(clearTimeout); timers.current = [];
    setComplete(true); setWidth(100); onPendingChange?.(false);
    timers.current.push(setTimeout(() => { setShown(false); setComplete(false); }, 200));
  }, [pathname, search, onPendingChange]);
  if (!shown) return null;
  return <span aria-hidden data-nav-progress className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-accent" style={{ width: `${reduced ? 100 : width}%`, opacity: complete ? 0 : reduced ? 0.6 : 1, transition: reduced ? "none" : complete ? "width 100ms, opacity 200ms" : "width 12s cubic-bezier(.1,.5,.1,1)" }} />;
}
