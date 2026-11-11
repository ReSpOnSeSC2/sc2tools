"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

/**
 * SettingsContext — lets a panel publish its dirty state up to the
 * shell so the shell can show a tab-level "unsaved" badge and guard
 * navigation away from a dirty tab.
 *
 * A tab can hold several forms (Chat has Multi-platform chat and the
 * chat bot; Profile has the profile fields and your channels), so dirty
 * state is kept per source: a tab is dirty while any of its sources is.
 *
 * Sources that save through a Save button register their save and reset
 * with `useSaveSource`. The shell renders one SaveBar for the open tab
 * (SettingsSaveBar) that saves every dirty source in order and discards
 * them all together, so two bars never stack.
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

/** What a form hands the tab's shared SaveBar. */
export interface SaveSourceOptions {
  /** Short lowercase noun for the bar's copy: "profile", "chat settings". */
  label: string;
  dirty: boolean;
  /**
   * Save this source's draft. Resolve `true` once it is saved, `false`
   * (or throw) when it failed: the source keeps its draft and shows its
   * own error detail; the bar names it and offers Retry.
   */
  save: () => Promise<boolean>;
  /** Snap the draft back to the saved value. */
  reset: () => void;
  /** Why this draft can't be saved yet. Blocks Save for the whole tab. */
  blocked?: string | null;
  /** Lower numbers save first; ties keep registration order. */
  order?: number;
}

/** A registered source as the shell's SaveBar sees it. */
export interface SaveSourceMeta {
  key: string;
  tabId: string;
  label: string;
  dirty: boolean;
  blocked: string | null;
  order: number;
  /** Registration sequence, the tie-breaker for `order`. */
  seq: number;
}

type SaveHandlers = MutableRefObject<SaveSourceOptions>;
type TabSaver = () => Promise<void>;

interface SaveRegistration {
  register: (key: string, handlers: SaveHandlers) => void;
  unregister: (key: string) => void;
  publish: (meta: Omit<SaveSourceMeta, "seq">) => void;
  /** Ask the tab's SaveBar to save everything (a form's Enter key). */
  requestSave: (tabId: string) => void;
}

interface SaveSourcesValue {
  sources: (tabId: string) => readonly SaveSourceMeta[];
  /** Run one source's save. A throw or a rejected save counts as failed. */
  run: (key: string) => Promise<boolean>;
  reset: (key: string) => void;
  /** The SaveBar for `tabId` offers its save-all to `requestSave`. */
  provideSaver: (tabId: string, saver: TabSaver | null) => void;
}

const DEFAULT_ORDER = 100;
const SaveRegistrationContext = createContext<SaveRegistration | null>(null);
const SaveSourcesContext = createContext<SaveSourcesValue | null>(null);

/** Sources for one tab, in save order. */
export function orderSaveSources(metas: Iterable<SaveSourceMeta>, tabId: string): SaveSourceMeta[] {
  return [...metas]
    .filter((meta) => meta.tabId === tabId)
    .sort((a, b) => a.order - b.order || a.seq - b.seq);
}

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

  const handlers = useRef(new Map<string, SaveHandlers>());
  const savers = useRef(new Map<string, TabSaver>());
  const sequence = useRef(0);
  const [metas, setMetas] = useState<Readonly<Record<string, SaveSourceMeta>>>({});
  const registration = useMemo<SaveRegistration>(() => ({
    register: (key, ref) => { handlers.current.set(key, ref); },
    unregister: (key) => {
      handlers.current.delete(key);
      setMetas((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    publish: (meta) => {
      setMetas((prev) => {
        const current = prev[meta.key];
        if (current && current.label === meta.label && current.dirty === meta.dirty && current.blocked === meta.blocked
          && current.order === meta.order && current.tabId === meta.tabId) return prev;
        return { ...prev, [meta.key]: { ...meta, seq: current?.seq ?? ++sequence.current } };
      });
    },
    requestSave: (tabId) => { void savers.current.get(tabId)?.(); },
  }), []);
  const sourcesValue = useMemo<SaveSourcesValue>(() => ({
    sources: (tabId) => orderSaveSources(Object.values(metas), tabId),
    run: async (key) => {
      const source = handlers.current.get(key)?.current;
      if (!source) return false;
      try { return (await source.save()) === true; } catch { return false; }
    },
    reset: (key) => { handlers.current.get(key)?.current.reset(); },
    provideSaver: (tabId, saver) => {
      if (saver) savers.current.set(tabId, saver);
      else savers.current.delete(tabId);
    },
  }), [metas]);

  return (
    <PublishDirtyContext.Provider value={setDirty}>
      <SaveRegistrationContext.Provider value={registration}>
        <SaveSourcesContext.Provider value={sourcesValue}>
          <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
        </SaveSourcesContext.Provider>
      </SaveRegistrationContext.Provider>
    </PublishDirtyContext.Provider>
  );
}

/** The shell's SaveBar reads the registered sources here. */
export function useSaveSources(): SaveSourcesValue | null {
  return useContext(SaveSourcesContext);
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

/**
 * Form hook — hand this form's draft to the tab's one SaveBar. Also
 * publishes the dirty state (tab badge, navigation guard), so a form
 * needs no separate `usePublishDirty`. The latest `save`/`reset` are
 * read when the bar runs them. Returns `requestSave`, which asks the
 * bar to save the whole tab (for a form's Enter key).
 *
 * Example:
 *   const { requestSave } = useSaveSource("profile", { label: "channels", dirty, save, reset, order: 1 });
 */
export function useSaveSource(tabId: string, options: SaveSourceOptions, sourceId?: string): { requestSave: () => void } {
  const registration = useContext(SaveRegistrationContext);
  const autoId = useId();
  const id = sourceId ?? autoId;
  const key = `${tabId}:${id}`;
  const latest = useRef(options);
  latest.current = options;
  usePublishDirty(tabId, options.dirty, id);
  useEffect(() => {
    if (!registration) return undefined;
    registration.register(key, latest);
    return () => registration.unregister(key);
  }, [registration, key]);
  const { label, dirty, blocked = null, order = DEFAULT_ORDER } = options;
  useEffect(() => {
    registration?.publish({ key, tabId, label, dirty, blocked, order });
  }, [registration, key, tabId, label, dirty, blocked, order]);
  const requestSave = useCallback(() => registration?.requestSave(tabId), [registration, tabId]);
  return { requestSave };
}
