"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { SavedViewList } from "@/components/analyzer/SavedViewList";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import {
  ADMIN_TREND_VIEW_LIMIT, BUILT_IN_VIEWS, TREND_VIEWS_PREF_PATH,
  type SavedTrendView, type TrendView, type TrendViewPreferences,
} from "./globalTrendsState";
import { INPUT } from "./GlobalGameFilters";

export function GlobalTrendsViews({ current, onApply, onClose }: {
  current: TrendView;
  onApply: (view: TrendView) => void;
  onClose: () => void;
}) {
  const prefs = useApi<TrendViewPreferences>(TREND_VIEWS_PREF_PATH, { revalidateOnFocus: false, shouldRetryOnError: false });
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const views = prefs.data?.views ?? [];

  const save = async (next: SavedTrendView[], message: string) => {
    if (locked.current || !prefs.data) return false;
    locked.current = true;
    setPending(true); setError(""); setNotice("");
    try {
      const saved = await prefs.request<TrendViewPreferences>({ method: "PUT", body: JSON.stringify({ revision: prefs.data.revision, views: next }) });
      await prefs.mutate(saved, { revalidate: false });
      setNotice(message);
      return true;
    } catch (failure) {
      const apiError = failure as ClientApiError;
      setError(apiError.message || "Could not save this view. Try again.");
      if (apiError.status === 409) await prefs.mutate().catch(() => {});
      return false;
    } finally { locked.current = false; setPending(false); }
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      setError("Enter a view name of 1–60 characters."); field.current?.focus(); return;
    }
    if ([...BUILT_IN_VIEWS, ...views].some(view => view.id !== editing && view.name.toLowerCase() === trimmed.toLowerCase())) {
      setError("A view with that name already exists."); field.current?.focus(); return;
    }
    if (editing && !views.some(view => view.id === editing)) {
      setError("This view was removed in another window."); return;
    }
    if (!editing && views.length >= ADMIN_TREND_VIEW_LIMIT) {
      setError(`You can save up to ${ADMIN_TREND_VIEW_LIMIT} views. Remove one first.`); return;
    }
    const next = editing ? views.map(view => view.id === editing ? { ...view, name: trimmed } : view)
      : [...views, { ...current, id: crypto.randomUUID(), name: trimmed }];
    if (await save(next, editing ? "View renamed." : "View saved.")) { setName(""); setEditing(null); field.current?.focus(); }
  };

  return <Modal open title="Global Trends views" description="Save the applied game filters and player cohort." size="lg" onClose={() => { if (!locked.current) onClose(); }}>
    <div className="space-y-5">
      <SavedViewList views={BUILT_IN_VIEWS} label="Built-in cohort presets" actions={view =>
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => onApply(view)}>Apply {view.name}</Button>} />
      {prefs.error && !prefs.data ? <RequestError title="Could not load saved views" error={prefs.error} onRetry={() => prefs.mutate()} />
        : !prefs.data ? <p role="status">Loading saved views…</p> : <>
          <form className="space-y-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <label htmlFor={id} className="block text-caption font-medium">{editing ? "Rename view" : "View name"}</label>
            <div className="flex flex-wrap gap-2">
              <input id={id} ref={field} maxLength={60} autoComplete="off" value={name} onChange={event => setName(event.target.value)} disabled={pending} className={`${INPUT} min-w-0 flex-1`} />
              <Button type="submit" disabled={pending}>{editing ? "Rename" : "Save current view"}</Button>
              {editing ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setEditing(null); setName(""); setError(""); }}>Cancel rename</Button> : null}
            </div>
            <p className="text-micro text-text-muted">{views.length}/{ADMIN_TREND_VIEW_LIMIT} views saved</p>
          </form>
          {views.length ? <SavedViewList views={views} label="Saved Global Trends views" actions={view => <>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => onApply(view)}>Apply {view.name}</Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setName(view.name); setEditing(view.id); setError(""); field.current?.focus(); }}>Rename {view.name}</Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void save(views.filter(row => row.id !== view.id), "View deleted.").then(saved => {
              if (saved && editing === view.id) { setEditing(null); setName(""); }
            }); }}>Delete {view.name}</Button>
          </>} /> : null}
        </>}
      {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      {notice ? <p role="status" className="text-caption text-success">{notice}</p> : null}
    </div>
  </Modal>;
}
