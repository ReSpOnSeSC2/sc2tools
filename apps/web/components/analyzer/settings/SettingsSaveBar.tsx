"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SaveBar } from "@/components/ui/SaveBar";
import { SettingsContextProvider, useSaveSources, type SaveSourceMeta } from "./SettingsContext";

/** "a", "a and b", "a, b and c". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

type Outcome = { saved: string[]; failedKeys: string[] };

/** The bar's copy for the current dirty sources and the last save attempt. */
export function saveBarCopy(dirty: readonly SaveSourceMeta[], outcome: Outcome | null): { message: string; saveLabel: string; blocked: boolean } {
  const blocker = dirty.find((source) => source.blocked);
  if (blocker && dirty.every((source) => source.blocked)) {
    return { message: blocker.blocked ?? "", saveLabel: outcome ? "Retry" : dirty.length === 1 ? `Save ${blocker.label}` : "Save all", blocked: true };
  }
  const failed = outcome ? dirty.filter((source) => outcome.failedKeys.includes(source.key)) : [];
  if (outcome && failed.length) {
    const saved = outcome.saved.length ? `Saved ${joinLabels(outcome.saved)}. ` : "";
    return { message: `${saved}Couldn't save ${joinLabels(failed.map((source) => source.label))}.`, saveLabel: "Retry", blocked: false };
  }
  return {
    message: `Unsaved changes to ${joinLabels(dirty.map((source) => source.label))}`,
    saveLabel: dirty.length === 1 ? `Save ${dirty[0].label}` : "Save all",
    blocked: false,
  };
}

/**
 * The one SaveBar for a Settings tab. Save runs every dirty source in
 * order (Profile before channels), one at a time, and keeps going past
 * a failure so the others still save. A failed source keeps its draft;
 * the bar stays with "Saved chat settings. Couldn't save bot settings."
 * and Retry. Discard resets every dirty source on the tab.
 *
 * Rendered once by SettingsShell for the open tab; key it by tab so a
 * previous tab's result never shows on another.
 */
export function SettingsSaveBar({ tabId }: { tabId: string }) {
  const registry = useSaveSources();
  const sources = registry?.sources(tabId) ?? [];
  const dirty = sources.filter((source) => source.dirty);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const latest = useRef({ registry, dirty });
  latest.current = { registry, dirty };

  const saveAll = useCallback(async () => {
    const { registry: current, dirty: pending } = latest.current;
    if (!current || running.current || !pending.length || pending.every((source) => source.blocked)) return;
    running.current = true;
    setSaving(true);
    const saved: string[] = [];
    const failedKeys: string[] = [];
    try {
      // One request at a time, in order: a later source may depend on an
      // earlier one (channels use the Pulse IDs the profile just saved).
      for (const source of pending) {
        // A source an earlier save already settled has nothing left to send.
        if (!live.current) break;
        if (!latest.current.dirty.some((item) => item.key === source.key && item.seq === source.seq)) continue;
        if (!source.blocked && await current.run(source.key)) saved.push(source.label);
        else failedKeys.push(source.key);
      }
    } finally {
      running.current = false;
      if (live.current) {
        setSaving(false);
        setOutcome(failedKeys.length ? { saved, failedKeys } : null);
      }
    }
  }, []);

  useEffect(() => {
    if (!registry) return undefined;
    registry.provideSaver(tabId, saveAll);
    return () => registry.provideSaver(tabId, null);
  }, [registry, tabId, saveAll]);

  // A failed source that is saved or discarded later is no longer failed;
  // editing it again starts a fresh draft, not a Retry.
  const dirtyKeys = dirty.map((source) => source.key).join("\n");
  useEffect(() => {
    setOutcome((previous) => {
      if (!previous) return previous;
      const open = new Set(dirtyKeys.split("\n"));
      const failedKeys = previous.failedKeys.filter((key) => open.has(key));
      if (failedKeys.length === previous.failedKeys.length) return previous;
      return failedKeys.length ? { ...previous, failedKeys } : null;
    });
  }, [dirtyKeys]);

  const discard = () => {
    setOutcome(null);
    for (const source of dirty) registry?.reset(source.key);
  };

  const copy = saveBarCopy(dirty, outcome);
  const message: ReactNode = <span role="status">{copy.message}</span>;
  return (
    <SaveBar
      visible={dirty.length > 0}
      saving={saving}
      saveDisabled={copy.blocked}
      stackOnMobile
      buttonClassName="min-h-11"
      onSave={() => void saveAll()}
      onReset={discard}
      saveLabel={copy.saveLabel}
      message={message}
    />
  );
}

/**
 * A Settings save scope outside the shell: the context plus the tab's
 * bar. Tests and embedded forms use it; SettingsShell does this itself.
 */
export function SettingsSaveScope({ tabId, children }: { tabId: string; children: ReactNode }) {
  return (
    <SettingsContextProvider>
      {children}
      <SettingsSaveBar tabId={tabId} />
    </SettingsContextProvider>
  );
}
