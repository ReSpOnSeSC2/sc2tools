"use client";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

export interface ChromeBreadcrumb { backHref: string; backLabel: string; trail: { label: string; href?: string }[] }
interface ContextValue { pathname: string; breadcrumb: ChromeBreadcrumb | null; publish: (owner: string, spec: ChromeBreadcrumb | null, pathname: string) => void }
const Context = createContext<ContextValue | null>(null);
export function ChromeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/app";
  const [entry, setEntry] = useState<{ owner: string; pathname: string; spec: ChromeBreadcrumb } | null>(null);
  const publish = useCallback((owner: string, spec: ChromeBreadcrumb | null, path: string) => {
    setEntry((current) => spec ? { owner, pathname: path, spec } : current?.owner === owner ? null : current);
  }, []);
  const value = useMemo(() => ({ pathname, breadcrumb: entry?.pathname === pathname ? entry.spec : null, publish }), [pathname, entry, publish]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useChromeContext = () => useContext(Context);
/** Page overrides expire on navigation and are harmless under marketing chrome. */
export function useChromeBreadcrumb(spec: ChromeBreadcrumb | null): boolean {
  const context = useChromeContext();
  const owner = useId();
  const encoded = JSON.stringify(spec);
  const publish = context?.publish;
  const currentPath = useRef(context?.pathname);
  currentPath.current = context?.pathname;
  useEffect(() => {
    const pathname = currentPath.current;
    if (!publish || !pathname) return;
    publish(owner, JSON.parse(encoded) as ChromeBreadcrumb | null, pathname);
    return () => publish(owner, null, pathname);
  }, [encoded, publish, owner]);
  return context !== null;
}
