"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * SettingsContext — lets a panel publish its dirty state up to the
 * shell so the shell can show a tab-level "unsaved" badge and guard
 * navigation away from a dirty tab.
 */
interface SettingsContextValue {
  isDirty: (tabId: string) => boolean;
  hasAnyDirty: () => boolean;
  setDirty: (tabId: string, dirty: boolean) => void;
}

const NOOP_VALUE: SettingsContextValue = {
  isDirty: () => false,
  hasAnyDirty: () => false,
  setDirty: () => {},
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  return ctx ?? NOOP_VALUE;
}

export function SettingsContextProvider({
  children,
  onDirtyChange,
}: {
  children: ReactNode;
  onDirtyChange?: (snapshot: Record<string, boolean>) => void;
}) {
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const dirtyRef = useRef(dirtyMap);
  dirtyRef.current = dirtyMap;

  const setDirty = useCallback(
    (tabId: string, dirty: boolean) => {
      setDirtyMap((prev) => {
        if (!!prev[tabId] === dirty) return prev;
        const next = { ...prev, [tabId]: dirty };
        onDirtyChange?.(next);
        return next;
      });
    },
    [onDirtyChange],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      isDirty: (tabId) => !!dirtyRef.current[tabId],
      hasAnyDirty: () => Object.values(dirtyRef.current).some(Boolean),
      setDirty,
    }),
    [setDirty],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

/**
 * Panel hook — publish dirty state to the shell. Cleans up to false on unmount.
 */
export function usePublishDirty(tabId: string, dirty: boolean): void {
  const { setDirty } = useSettingsContext();
  useEffect(() => {
    setDirty(tabId, dirty);
    return () => setDirty(tabId, false);
  }, [tabId, dirty, setDirty]);
}
