"use client";

import { useEffect, type RefObject } from "react";

/**
 * The custom property AppChrome sets on <html> while it is mounted: the
 * mobile tab bar's height in px, its safe-area padding included. The
 * `bottom-above-chrome` inset in tailwind.config.ts reads it, so the Save
 * bar, toasts, the update prompt and the cookie banner float just above
 * the tab bar instead of underneath it.
 */
export const CHROME_BOTTOM_VAR = "--chrome-bottom";

/**
 * Keep `--chrome-bottom` equal to the rendered height of `ref`'s element.
 *
 * The tab bar is `md:hidden`, so on wider screens it measures 0 and the
 * offset collapses to the safe area. The property is removed on unmount:
 * marketing pages have no tab bar and fall back to the safe area alone.
 *
 * Example:
 *   const tabBar = useRef<HTMLElement>(null);
 *   useChromeBottomInset(tabBar);
 *   <nav ref={tabBar} className="fixed bottom-0 md:hidden">…</nav>
 */
export function useChromeBottomInset(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      root.style.setProperty(CHROME_BOTTOM_VAR, `${height}px`);
    };
    publish();
    // Old browsers without ResizeObserver keep the first measurement.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(CHROME_BOTTOM_VAR);
    };
  }, [ref]);
}
