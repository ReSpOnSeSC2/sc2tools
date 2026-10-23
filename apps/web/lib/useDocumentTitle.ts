"use client";

import { useEffect } from "react";
import { siteTitle } from "./siteTitle";

/**
 * Name the browser tab after what is on screen when that changes without
 * a route change (a Settings tab, say). Formats like the root title
 * template: `useDocumentTitle("Overlay · Settings")` →
 * "Overlay · Settings · SC2 Tools". Pass null to leave the route's own
 * title alone.
 *
 * On unmount the previous title comes back, but only if nothing else
 * has changed it since: when a navigation already put the next page's
 * title in place, that one stays.
 *
 * Example:
 *   useDocumentTitle(`${activeTab.label} · Settings`);
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    const next = siteTitle(title);
    document.title = next;
    return () => {
      if (document.title === next) document.title = previous;
    };
  }, [title]);
}
