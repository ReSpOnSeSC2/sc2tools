"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Guard = { dirty: boolean; discard: () => void };
type Context = { isDirty: boolean; register: (guard: Guard) => void; navigate: (action: () => void) => void };
const UnsavedNoteContext = createContext<Context | null>(null);
export const useUnsavedNote = () => useContext(UnsavedNoteContext);

export function UnsavedNoteProvider({ children, onLeaveList }: { children: ReactNode; onLeaveList?: () => void }) {
  const guard = useRef<Guard>({ dirty: false, discard: () => undefined });
  const [isDirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  const register = useCallback((value: Guard) => { guard.current = value; setDirty(value.dirty); }, []);
  const navigate = useCallback((action: () => void) => { if (guard.current.dirty) setPending({ action }); else action(); }, []);
  useEffect(() => {
    if (!isDirty || !onLeaveList) return;
    // Chrome lives above this provider. Capture its list breadcrumb, as well
    // as the dossier's own link, before Next starts same-tab navigation.
    const follow = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== "/app/opponents") return;
      event.preventDefault(); event.stopPropagation(); navigate(onLeaveList);
    };
    document.addEventListener("click", follow, true);
    return () => document.removeEventListener("click", follow, true);
  }, [isDirty, navigate, onLeaveList]);
  const value = useMemo(() => ({ isDirty, register, navigate }), [isDirty, register, navigate]);
  return <UnsavedNoteContext.Provider value={value}>{children}<ConfirmDialog open={pending !== null} title="Discard unsaved note?" description="Your saved scouting note will stay as it is." confirmLabel="Discard" cancelLabel="Keep editing" focusCancel onClose={() => setPending(null)} onConfirm={() => { guard.current.discard(); const action = pending?.action; setPending(null); action?.(); }} /></UnsavedNoteContext.Provider>;
}
