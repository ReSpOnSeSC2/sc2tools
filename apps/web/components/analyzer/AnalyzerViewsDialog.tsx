"use client";

import { useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { useApi, apiCall } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { ANALYZER_VIEW_LIMIT, analyzerViewHref, sanitizeAnalyzerViews, sanitizeViewFilters, type AnalyzerView, type AnalyzerViewPrefs } from "@/lib/analyzerViews";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

export function AnalyzerViewsDialog({ onClose }: { onClose: () => void }) {
  const { userId } = useAuth();
  const owner = useRef(userId); owner.current = userId;
  return <Modal open onClose={onClose} title="Saved views" description="Save filters and their analysis section. Shared links show each viewer's own history." size="lg"><ViewsEditor key={userId ?? "signed-out"} owner={owner} onClose={onClose} /></Modal>;
}

function ViewsEditor({ owner, onClose }: { owner: { current: string | null | undefined }; onClose: () => void }) {
  const { getToken, userId } = useAuth(), pathname = usePathname(), router = useRouter();
  const { filters } = useFilters();
  const request = useApi<AnalyzerViewPrefs>("/v1/me/preferences/analyzerViews", { revalidateOnFocus: false });
  const prefs = sanitizeAnalyzerViews(request.data);
  const [name, setName] = useState(""), [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [announcement, setAnnouncement] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const persist = async (next: AnalyzerViewPrefs, message: string) => {
    if (pending) return false;
    setPending(true); setError(""); setAnnouncement("");
    try {
      const boundToken = async () => { const token = await getToken(); if (owner.current !== userId) throw new Error("Account changed. Open Views again."); return token; };
      const saved = await apiCall<AnalyzerViewPrefs>(boundToken, "/v1/me/preferences/analyzerViews", { method: "PUT", body: JSON.stringify(next) });
      if (owner.current !== userId) return false;
      await request.mutate(sanitizeAnalyzerViews(saved), { revalidate: false }); setAnnouncement(message); return true;
    } catch (failure) { if (owner.current === userId) setError((failure as { message?: string }).message || "Couldn't save these views. Try again."); return false; }
    finally { if (owner.current === userId) setPending(false); }
  };
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60 || /[\u0000-\u001f\u007f]/.test(trimmed)) { setError("Enter a view name of 1–60 characters."); field.current?.focus(); return; }
    if (prefs.views.some(view => view.id !== editing && view.name.toLowerCase() === trimmed.toLowerCase())) { setError("A view with that name already exists."); return; }
    if (!editing && prefs.views.length >= ANALYZER_VIEW_LIMIT) { setError("You can save up to 12 views. Rename or remove one first."); return; }
    const section = pathname?.split("/")[2] || "today";
    const row: AnalyzerView = { id: crypto.randomUUID(), name: trimmed, filters: sanitizeViewFilters(filters), section };
    const views = editing ? prefs.views.map(view => view.id === editing ? { ...view, name: trimmed } : view) : [...prefs.views, row];
    if (await persist({ ...prefs, views }, editing ? "View renamed." : "View saved.")) { setName(""); setEditing(null); field.current?.focus(); }
  };
  if (request.error && !request.data) return <RequestError title="Couldn't load saved views" error={request.error} onRetry={() => request.mutate()} />;
  if (!request.data && request.isLoading) return <p role="status">Loading saved views…</p>;
  return <div className="space-y-5">
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block text-caption font-medium" htmlFor="analyzer-view-name">{editing ? "Rename view" : "View name"}</label>
      <div className="flex flex-wrap gap-2"><input ref={field} id="analyzer-view-name" autoComplete="off" maxLength={60} value={name} onChange={event => setName(event.target.value)} disabled={pending} className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg-surface px-3 text-body" /><Button type="submit" disabled={pending}>{editing ? "Rename" : "Save current view"}</Button>{editing ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setName(""); setEditing(null); }}>Cancel rename</Button> : null}</div>
      <p className="text-micro text-text-muted">{prefs.views.length}/{ANALYZER_VIEW_LIMIT} views saved. A default view opens on the first plain Today visit of a browser session.</p>
    </form>
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
    {announcement ? <p role="status" className="text-caption text-success">{announcement}</p> : null}
    {prefs.views.length ? <ul className="space-y-3" aria-label="Saved analyzer views">{prefs.views.map(view => <li key={view.id} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="min-w-0 break-words text-caption">{view.name}</strong><span className="text-micro text-text-muted">{view.section ?? "today"}{prefs.defaultViewId === view.id ? " · Default view" : ""}</span></div>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={pending} onClick={() => { router.replace(analyzerViewHref(view), { scroll: false }); onClose(); }}>Apply {view.name}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => { setEditing(view.id); setName(view.name); field.current?.focus(); }}>Rename {view.name}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => { void persist({ ...prefs, defaultViewId: prefs.defaultViewId === view.id ? null : view.id }, prefs.defaultViewId === view.id ? "Default view cleared." : "Default view set."); }}>{prefs.defaultViewId === view.id ? "Clear default view" : `Set ${view.name} as default`}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => { void persist({ views: prefs.views.filter(row => row.id !== view.id), defaultViewId: prefs.defaultViewId === view.id ? null : prefs.defaultViewId }, "View deleted."); }}>Delete {view.name}</Button></div>
    </li>)}</ul> : <p className="text-caption text-text-muted">No saved views yet. Save the current filters to reopen them later.</p>}
    <LazyHelpLink slug="analyzer-filters" anchor="save-and-share-a-view">Save and share a view</LazyHelpLink>
  </div>;
}
