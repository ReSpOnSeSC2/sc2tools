import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const setting = document.documentElement.dataset.motion;
  if (setting === "reduce" || setting === "full") return setting === "reduce";
  return Boolean(window.matchMedia?.(QUERY).matches);
}

function subscribe(refresh: () => void): () => void {
  const media = window.matchMedia?.(QUERY);
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  if (media?.addEventListener) media.addEventListener("change", refresh);
  else media?.addListener?.(refresh);
  return () => {
    observer.disconnect();
    if (media?.removeEventListener) media.removeEventListener("change", refresh);
    else media?.removeListener?.(refresh);
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
