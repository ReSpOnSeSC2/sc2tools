"use client";

import { useLayoutEffect, useState } from "react";

/** Coarse pointers keep Fit in landscape; normal desktop charts retain their layout. */
export const MACRO_OVERVIEW_QUERY = "(max-width: 639px), (pointer: coarse)";
function matchesOverview() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MACRO_OVERVIEW_QUERY).matches;
}

export function useMacroOverviewMode(requested: boolean) {
  const [matches, setMatches] = useState(matchesOverview);
  useLayoutEffect(() => {
    if (!requested || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MACRO_OVERVIEW_QUERY);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [requested]);
  return requested && matches;
}
