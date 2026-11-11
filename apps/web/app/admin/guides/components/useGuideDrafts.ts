"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { GUIDE_MARKDOWN_MAX_CHARS } from "@/lib/guides/markdown";
import { GUIDE_MATCHUPS, guideBuildOptions, guideDisplayName, isGuideMatchup } from "@/lib/guides/slugs";
import type { GuideAdminNote, GuideAdminNoteSaveResponse, GuideAdminNotesPayload } from "@/lib/guides/types";
import { adminErrorText, guideNoteApiPath, guideNoteKey, withDraft, type AdminNoticeValue, type AdminResource, type GuideSelection } from "./guidesAdminShared";

type Drafts = Record<string, string>;
type Busy = "save" | "delete" | null;

export function guideDraftStorageKey(owner: string, key: string) {
  return `admin-guide-draft:${encodeURIComponent(owner)}:${encodeURIComponent(key)}`;
}

function updateDraftStorage(owner: string, key: string, value?: string) {
  try {
    const storageKey = guideDraftStorageKey(owner, key);
    if (value === undefined) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, value);
  } catch { /* The in-memory draft stays editable if storage is unavailable. */ }
}

function restoreDrafts(owner: string, stored: ReadonlyMap<string, GuideAdminNote>) {
  const drafts: Drafts = {};
  try {
    for (const matchup of GUIDE_MATCHUPS) {
      for (const build of guideBuildOptions(matchup)) {
        const key = guideNoteKey(matchup, build.name);
        const body = sessionStorage.getItem(guideDraftStorageKey(owner, key));
        if (body === null) continue;
        if (body.length <= GUIDE_MARKDOWN_MAX_CHARS && body !== (stored.get(key)?.body ?? "")) drafts[key] = body;
        else updateDraftStorage(owner, key);
      }
    }
  } catch { /* The page remains usable without browser storage. */ }
  return drafts;
}

export function draftGuideName(key: string) {
  const [, build] = key.split("\u0000");
  return guideDisplayName(build ?? "");
}

function draftApiPath(key: string) {
  const [matchup, buildKey] = key.split("\u0000");
  return isGuideMatchup(matchup) && buildKey ? guideNoteApiPath(matchup, buildKey) : null;
}

export function useGuideDrafts(notes: AdminResource<GuideAdminNotesPayload>, owner: RefObject<string | null | undefined>) {
  const { getToken, userId } = useAuth();
  const [drafts, setDrafts] = useState<Drafts>({});
  const draftRef = useRef<Drafts>({});
  const [busy, setBusy] = useState<Busy>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && owner.current === userId;
  const restored = useRef(false);
  const [restoredCount, setRestoredCount] = useState(0);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<AdminNoticeValue | null>(null);
  const noteByKey = useMemo(() => new Map((notes.data?.items ?? []).map(note => [guideNoteKey(note.matchup, note.buildKey), note])), [notes.data]);
  const ready = Boolean(userId && notes.data && !notes.error);
  const dirtyKeys = Object.keys(drafts).filter(key => drafts[key] !== (noteByKey.get(key)?.body ?? ""));

  useEffect(() => {
    if (!ready || !userId || restored.current) return;
    restored.current = true;
    const restoredDrafts = restoreDrafts(userId, noteByKey);
    draftRef.current = restoredDrafts;
    setDrafts(restoredDrafts);
    setRestoredCount(Object.keys(restoredDrafts).length);
  }, [ready, userId, noteByKey]);

  const replaceDrafts = (next: Drafts) => {
    if (!userId || !current()) return;
    const previous = draftRef.current;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[key] !== next[key]) updateDraftStorage(userId, key, next[key]);
    }
    draftRef.current = next;
    setDrafts(next);
  };

  const forget = (keys: string[]) => {
    const next = { ...draftRef.current };
    keys.forEach(key => { delete next[key]; });
    replaceDrafts(next);
    setFailures(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !keys.includes(key))));
  };

  const token = async () => {
    if (!userId || !current()) throw new Error("The admin account changed.");
    const value = await getToken();
    if (!current()) throw new Error("The admin account changed.");
    return value;
  };

  const updateCache = (key: string, item: GuideAdminNote | null) => notes.mutate(current => ({
    items: [...(current?.items ?? []).filter(note => guideNoteKey(note.matchup, note.buildKey) !== key), ...(item ? [item] : [])],
  }), { revalidate: false });

  const save = async (keys: string[], shortcut = false) => {
    if (locked.current || !ready) return;
    const entries = keys.flatMap(key => {
      const body = draftRef.current[key];
      const path = draftApiPath(key);
      return path && body !== undefined && body !== (noteByKey.get(key)?.body ?? "") ? [{ key, path, body }] : [];
    });
    if (!entries.length) return;
    locked.current = true; setBusy("save"); setNotice(null);
    let saved = 0;
    try {
      for (const { key, path, body } of entries) {
        if (!current()) return;
        try {
          const response = await apiCall<GuideAdminNoteSaveResponse>(token, path, { method: "PUT", body: JSON.stringify({ body }) });
          if (!current()) return;
          await updateCache(key, response?.note ?? null).catch(() => {});
          if (!current()) return;
          forget([key]);
          saved++;
        } catch (error) {
          if (!current()) return;
          setFailures(previous => ({ ...previous, [key]: adminErrorText("Could not save this note.", error) }));
        }
      }
      if (saved) {
        setNotice({ tone: "success", text: shortcut ? "Saved." : entries.length === 1
          ? `Saved the coach's notes for ${draftGuideName(entries[0].key)}.` : `Saved ${saved} ${saved === 1 ? "note" : "notes"}.` });
        void notes.mutate().catch(() => {});
      }
    } finally { locked.current = false; if (current()) setBusy(null); }
  };

  const remove = async (selection: GuideSelection) => {
    const key = guideNoteKey(selection.matchup, selection.buildKey);
    const path = draftApiPath(key);
    if (!path || locked.current || !ready) return false;
    locked.current = true; setBusy("delete"); setNotice(null);
    try {
      await apiCall(token, path, { method: "DELETE" });
      if (!current()) return false;
      await updateCache(key, null).catch(() => {});
      if (!current()) return false;
      forget([key]);
      setNotice({ tone: "success", text: `Deleted the coach's notes for ${draftGuideName(key)}.` });
      void notes.mutate().catch(() => {});
      return true;
    } catch (error) {
      if (current()) setNotice({ tone: "error", text: adminErrorText("Couldn't delete the notes.", error) });
      return false;
    } finally { locked.current = false; if (current()) setBusy(null); }
  };

  return { drafts, dirtyKeys, noteByKey, ready, busy, restoredCount, failures, notice, save, remove,
    edit: (key: string, body: string) => {
      if (locked.current || body.length > GUIDE_MARKDOWN_MAX_CHARS) return;
      const next = withDraft(draftRef.current, key, body, noteByKey.get(key)?.body ?? "");
      if (Object.hasOwn(next, key)) replaceDrafts(next);
      else forget([key]);
    },
    discard: (keys: string[]) => { if (!locked.current) forget(keys); },
    dismissRestored: () => setRestoredCount(0),
  };
}
