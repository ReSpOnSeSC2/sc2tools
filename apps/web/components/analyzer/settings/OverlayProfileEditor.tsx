"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import { normalizeOverlayProfile, defaultOverlayProfile, type OverlayProfile } from "@/lib/overlayProfile";
import { normalizeOverlayTheme, type OverlayTheme } from "@/lib/overlayTheme";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { SaveBar } from "@/components/ui/SaveBar";
import { Button } from "@/components/ui/Button";
import { usePublishDirty } from "./SettingsContext";
import type { OverlayToken } from "./OverlayTokenHeader";

type SavedProfile = { profile: OverlayProfile; profileRevision: number };
type EditorControls = { profile: OverlayProfile; saving: boolean; setTheme: (theme: OverlayTheme) => void; setDuration: (widget: string, durationSec: number | null) => void };

/** One draft spans Look and Widgets. Mount keyed by authenticated owner + token. */
export function OverlayProfileEditor({ token, children, onSaved }: {
  token: OverlayToken; children: (controls: EditorControls) => ReactNode;
  onSaved: (saved: SavedProfile) => void;
}) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const scope = `${isLoaded && isSignedIn ? userId : ""}:${token.token}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [accepted, setAccepted] = useState<SavedProfile | null>(null);
  const remote = useMemo<SavedProfile>(() => ({ profile: normalizeOverlayProfile(token.profile), profileRevision: token.profileRevision ?? 0 }), [token.profile, token.profileRevision]);
  const server = accepted && accepted.profileRevision > remote.profileRevision ? accepted : remote;
  const { draft, setDraft, dirty, hydrated, reset, markSaved } = useDirtyForm(server.profile, defaultOverlayProfile());
  const baselineRevision = useRef(server.profileRevision);
  const pending = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [legacyTheme, setLegacyTheme] = useState<OverlayTheme | null>(null);
  const migrationKey = `sc2tools:overlay-profile-migration:${userId}:${token.token}`;
  usePublishDirty("overlay", dirty, "overlay-profile");
  useEffect(() => { if (!dirty) baselineRevision.current = server.profileRevision; }, [dirty, server.profileRevision]);
  useLayoutEffect(() => { currentScope.current = scope; return () => { currentScope.current = ""; pending.current?.abort(); }; }, [scope]);
  useEffect(() => {
    try {
      if (localStorage.getItem(migrationKey)) return;
      const raw = localStorage.getItem(`sc2tools:overlay-theme:${token.token}`);
      const previous = normalizeOverlayTheme(raw ? JSON.parse(raw) : null);
      if (Object.keys(previous).length && !Object.keys(server.profile.theme).length) setLegacyTheme(previous);
    } catch { /* Migration is optional when this browser's storage is unavailable. */ }
    // Only inspect the previous device preference at this owner's mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrationKey, token.token]);
  const dismissMigration = () => {
    setLegacyTheme(null);
    try { localStorage.setItem(migrationKey, "1"); } catch { /* No persistent write is required. */ }
  };
  const change = (next: OverlayProfile) => { setMessage(null); setDraft(normalizeOverlayProfile(next)); };
  const save = async () => {
    if (pending.current || !dirty || !userId || !isLoaded || !isSignedIn) return;
    const controller = new AbortController(); pending.current = controller;
    const admittedScope = scope; setSaving(true); setMessage(null);
    try {
      const result = await boundedApiRequest(signal => apiCall<SavedProfile>(async () => {
        const jwt = await getToken();
        if (currentScope.current !== admittedScope) throw new DOMException("Owner changed", "AbortError");
        signal.throwIfAborted(); return jwt;
      }, `/v1/overlay-tokens/${encodeURIComponent(token.token)}/profile`, {
        method: "PUT", signal, body: JSON.stringify({ profile: draft, expectedRevision: baselineRevision.current }),
      }), 20_000, controller.signal);
      if (currentScope.current !== admittedScope || controller.signal.aborted) return;
      if (!result || !Number.isSafeInteger(result.profileRevision) || result.profileRevision <= baselineRevision.current) throw new Error("Couldn't verify the saved overlay profile.");
      const saved = { profile: normalizeOverlayProfile(result.profile), profileRevision: result.profileRevision };
      baselineRevision.current = saved.profileRevision; setAccepted(saved); setDraft(saved.profile); markSaved(); onSaved(saved);
      setMessage("Overlay display saved. Connected sources update now; durations apply on the next appearance. Existing URLs with a theme override keep that look.");
    } catch (error) {
      if (currentScope.current !== admittedScope || controller.signal.aborted) return;
      setMessage((error as ClientApiError)?.status === 409
        ? "This overlay changed in another tab. Reload Settings to review the latest profile before saving again. Your draft is still here."
        : (error as ClientApiError)?.code === "request_timeout" ? "Saving the overlay took too long. Try again. Your draft is still here."
        : (error as ClientApiError)?.message || "Couldn't save the overlay display. Try again.");
    } finally {
      if (currentScope.current === admittedScope) { pending.current = null; setSaving(false); }
    }
  };
  return <>
    {legacyTheme ? <aside className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-4" aria-label="Previous overlay theme">
      <h2 className="text-body font-semibold">Move your theme to your overlay</h2>
      <p className="text-caption text-text-muted">This browser has a previous theme. Add it to your draft, then Save to update connected sources. Nothing moves automatically.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { change({ ...draft, theme: legacyTheme }); dismissMigration(); }} disabled={saving}>Use previous theme</Button><Button variant="ghost" onClick={dismissMigration}>Dismiss</Button></div>
    </aside> : null}
    {children({ profile: draft, saving: saving || !hydrated, setTheme: theme => change({ ...draft, theme }), setDuration: (widget, durationSec) => change({ ...draft, widgetOptions: { ...draft.widgetOptions, [widget]: { durationSec } } }) })}
    {message ? <p role="status" className="rounded-lg border border-border bg-bg-surface p-3 text-caption text-text-muted">{message}</p> : null}
    <SaveBar visible={dirty} saving={saving} onSave={() => void save()} onReset={() => { reset(); setMessage(null); }} saveLabel="Save overlay display" buttonClassName="min-h-11" stackOnMobile message="Unsaved overlay display" />
  </>;
}
