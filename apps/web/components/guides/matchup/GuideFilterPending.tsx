"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const PendingContext = createContext({ label: "", report: (_id: string, _label: string | null) => {} });

export function GuideFilterPendingProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Record<string, string>>({});
  const report = useCallback((id: string, label: string | null) => setPending((old) => {
    if (old[id] === label || (!label && !(id in old))) return old;
    const next = { ...old };
    if (label) next[id] = label; else delete next[id];
    return next;
  }), []);
  const label = Object.values(pending).at(-1) ?? "";
  const value = useMemo(() => ({ label, report }), [label, report]);
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export const useGuideFilterPending = () => useContext(PendingContext);

export function GuideFilterRegion({ children }: { children: ReactNode }) {
  const { label } = useGuideFilterPending();
  return <div aria-busy={Boolean(label)} className={label ? "opacity-60 transition-opacity" : "transition-opacity"}>
    <p role="status" className="sr-only">{label ? `Loading ${label} openers…` : ""}</p>{children}
  </div>;
}
