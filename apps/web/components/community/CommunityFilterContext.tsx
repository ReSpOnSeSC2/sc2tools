"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const CommunityFilterContext = createContext<{ pending: boolean; setPending: (pending: boolean) => void } | null>(null);
export function CommunityFilterProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const value = useMemo(() => ({ pending, setPending }), [pending]);
  return <CommunityFilterContext.Provider value={value}>{children}</CommunityFilterContext.Provider>;
}
export function useCommunityFilterState() {
  const context = useContext(CommunityFilterContext);
  if (!context) throw new Error("Community filters need CommunityFilterProvider");
  return context;
}
export function CommunityResults({ children }: { children: ReactNode }) {
  const { pending } = useCommunityFilterState();
  return <div role="region" aria-label="Community build results" aria-busy={pending || undefined} className={`space-y-4 transition-opacity ${pending ? "opacity-60" : ""}`}>{children}</div>;
}
