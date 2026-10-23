"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * SettingsContext — lets a panel publish its dirty state up to the
 * shell so the shell can show a tab-level "unsaved" badge and guard
 * navigation away from a dirty tab.
 *
 * A tab can hold several forms with their own Save buttons (the Overlay
 * tab has Multi-platform chat and the chat bot), so dirty state is kept
 * per source: a tab is dirty while any of its sources is.
 */
interface SettingsContextValue {
  isDirty: (tabId: string) => boolean;
  hasAnyDirty: () => boolean;
  /** `sourceId` defaults to the tab id (one form per tab). */
  setDirty: (tabId: string, dirty: boolean, sourceId?: string) => void;
}

type SetDirty = SettingsContextValue["setDirty"];

/** Tab id -> the sources on that tab with unsaved edits. */
type DirtyMap = Readonly<Record<string, ReadonlySet<string>>>;

const NOOP_VALUE: SettingsContextValue = {
  isDirty: () => false,
  hasAnyDirty: () => false,
  setDirty: () => {},
};

const SettingsContext = createContext<SettingsContextValue | null>(null);
// The setter never changes, so publishing panels don't re-render every
// time another form on the page turns dirty or clean.
const PublishDirtyContext = createContext<SetDirty | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  return ctx ?? NOOP_VALUE;
}

function tabSnapshot(map: DirtyMap): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [tabId, sources] of Object.entries(map)) out[tabId] = sources.size > 0;
  return out;
}

export function SettingsContextProvider({
  children,
  onDirtyChange,
}: {
  children: ReactNode;
  onDirtyChange?: (snapshot: Record<string, boolean>) => void;
}) {
  const [dirtyMap, setDirtyMap] = useState<DirtyMap>({});

  const setDirty = useCallback<SetDirty>(
    (tabId, dirty, sourceId = tabId) => {
      setDirtyMap((prev) => {
        const sources = prev[tabId];
        if (!!sources?.has(sourceId) === dirty) return prev;
        const nextSources = new Set(sources);
        if (dirty) nextSources.add(sourceId);
        else nextSources.delete(sourceId);
        const next = { ...prev, [tabId]: nextSources };
        onDirtyChange?.(tabSnapshot(next));
        return next;
      });
    },
    [onDirtyChange],
  );

  // A new value per change re-renders the shell, so the tab badges
  // follow the forms.
  const value = useMemo<SettingsContextValue>(
    () => ({
      isDirty: (tabId) => (dirtyMap[tabId]?.size ?? 0) > 0,
      hasAnyDirty: () => Object.values(dirtyMap).some((sources) => sources.size > 0),
      setDirty,
    }),
    [dirtyMap, setDirty],
  );

  return (
    <PublishDirtyContext.Provider value={setDirty}>
      <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
    </PublishDirtyContext.Provider>
  );
}

/**
 * Panel hook — publish a form's dirty state to the shell. Each call is
 * its own source, so two forms on one tab never clear each other.
 * Cleans up to clean on unmount.
 *
 * Example:
 *   usePublishDirty("overlay", dirty); // a form on the Overlay tab
 */
export function usePublishDirty(tabId: string, dirty: boolean, sourceId?: string): void {
  const setDirty = useContext(PublishDirtyContext) ?? NOOP_VALUE.setDirty;
  const autoId = useId();
  const source = sourceId ?? autoId;
  useEffect(() => {
    setDirty(tabId, dirty, source);
    return () => setDirty(tabId, false, source);
  }, [tabId, dirty, source, setDirty]);
}
