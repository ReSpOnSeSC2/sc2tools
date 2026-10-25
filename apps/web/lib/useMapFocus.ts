"use client";

import { useSyncExternalStore } from "react";

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}
export function useMapFocus(): string | null {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const focus = new URLSearchParams(search).get("focus");
  return focus && focus.length <= 200 && !/[\u0000-\u001f\u007f]/.test(focus) ? focus : null;
}
