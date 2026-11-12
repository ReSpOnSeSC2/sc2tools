"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import {
  normalizeOverlayProfile, defaultOverlayProfile, overlayProfileFlags, withoutOverlayFlags,
  type OverlayProfile, type OverlayProfileFlags,
} from "@/lib/overlayProfile";
import { normalizeOverlayTheme, type OverlayTheme } from "@/lib/overlayTheme";
import { legacyOverlayFlags, overlayFlagsMigrationKey } from "@/lib/overlayFlagsMigration";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { Button } from "@/components/ui/Button";
import { useSaveSource } from "./SettingsContext";
import { OverlayFlagsContext, type OverlayFlags } from "./overlayFlags";
import type { OverlayToken } from "./OverlayTokenHeader";
import type { SetOverlayLayout } from "./OverlayLayoutEditor";

type SavedProfile = { profile: OverlayProfile; profileRevision: number };
type EditorControls = { profile: OverlayProfile; saving: boolean; setTheme: (theme: OverlayTheme) => void; setDuration: (widget: string, durationSec: number | null) => void; setLayout: SetOverlayLayout };

const CONFLICT = "This overlay changed in another tab. Reload Settings to review the latest profile before saving again. Your draft is still here.";

/**
 * One draft spans Look and Widgets and saves through the Overlay tab's
 * SaveBar. The credit, QR and Ghost voice switches are Instant: each change
 * saves right away into the same profile (without touching the draft), and
 * an older per-browser choice moves in once, silently.
 * Mount keyed by authenticated owner + token.
 */
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
  const draftBase = useMemo(() => withoutOverlayFlags(server.profile), [server.profile]);
  const { draft, setDraft, dirty, hydrated, reset, markSaved } = useDirtyForm(draftBase, defaultOverlayProfile());
  const baselineRevision = useRef(server.profileRevision);
  const pending = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [flagSaving, setFlagSaving] = useState(false);
  const [optimistic, setOptimistic] = useState<OverlayProfileFlags>({});
  const [legacyTheme, setLegacyTheme] = useState<OverlayTheme | null>(null);
  const migrationKey = `sc2tools:overlay-profile-migration:${userId}:${token.token}`;
  const discard = () => { reset(); setMessage(null); };
  useSaveSource("overlay", { label: "overlay display", dirty, save, reset: discard }, "overlay-profile");
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
  const change = (next: OverlayProfile) => { setMessage(null); setDraft(withoutOverlayFlags(normalizeOverlayProfile(next))); };

  const setLayout: SetOverlayLayout = (canvas, update) => {
    const key = canvas === "vertical" ? "layoutVertical" : "layout";
    setMessage(null);
    setDraft(current => withoutOverlayFlags(normalizeOverlayProfile({ ...current, [key]: update(current[key] ?? {}) })));
  };

  /** PUT one profile with CAS; resolves the verified saved profile. */
  async function send(profile: OverlayProfile, expectedRevision: number, controller: AbortController): Promise<SavedProfile | null> {
    const admittedScope = scope;
    const result = await boundedApiRequest(signal => apiCall<SavedProfile>(async () => {
      const jwt = await getToken();
      if (currentScope.current !== admittedScope) throw new DOMException("Owner changed", "AbortError");
      signal.throwIfAborted(); return jwt;
    }, `/v1/overlay-tokens/${encodeURIComponent(token.token)}/profile`, {
      method: "PUT", signal, body: JSON.stringify({ profile, expectedRevision }),
    }), 20_000, controller.signal);
    if (currentScope.current !== admittedScope || controller.signal.aborted) return null;
    if (!result || !Number.isSafeInteger(result.profileRevision) || result.profileRevision <= expectedRevision) throw new Error("Couldn't verify the saved overlay profile.");
    return { profile: normalizeOverlayProfile(result.profile), profileRevision: result.profileRevision };
  }

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    if (pending.current || !userId || !isLoaded || !isSignedIn) return false;
    const controller = new AbortController(); pending.current = controller;
    const admittedScope = scope; setSaving(true); setMessage(null);
    try {
      // The draft never carries the Instant flags: send the saved ones.
      const saved = await send({ ...draft, ...overlayProfileFlags(server.profile) }, baselineRevision.current, controller);
      if (!saved) return false;
      baselineRevision.current = saved.profileRevision; setAccepted(saved); setDraft(withoutOverlayFlags(saved.profile)); markSaved(); onSaved(saved);
      setMessage("Overlay display saved. Connected sources update now; durations apply on the next appearance. Existing URLs with a theme override keep that look.");
      return true;
    } catch (error) {
      if (currentScope.current !== admittedScope || controller.signal.aborted) return false;
      setMessage((error as ClientApiError)?.status === 409 ? CONFLICT
        : (error as ClientApiError)?.code === "request_timeout" ? "Saving the overlay took too long. Try again. Your draft is still here."
        : (error as ClientApiError)?.message || "Couldn't save the overlay display. Try again.");
      return false;
    } finally {
      if (currentScope.current === admittedScope) { pending.current = null; setSaving(false); }
    }
  }

  /** Instant: save only these flags on top of the saved profile. */
  async function saveFlags(patch: OverlayProfileFlags, quiet = false): Promise<boolean> {
    if (pending.current || !userId || !isLoaded || !isSignedIn) return false;
    const controller = new AbortController(); pending.current = controller;
    const admittedScope = scope, base = server;
    setFlagSaving(true);
    if (!quiet) { setMessage(null); setOptimistic(patch); }
    try {
      const saved = await send({ ...base.profile, ...patch }, base.profileRevision, controller);
      if (!saved) return false;
      // Only the flags changed, so a draft built on the previous revision
      // still matches the saved theme: move its CAS baseline forward too.
      if (baselineRevision.current === base.profileRevision) baselineRevision.current = saved.profileRevision;
      setAccepted(saved); onSaved(saved);
      return true;
    } catch (error) {
      if (currentScope.current !== admittedScope || controller.signal.aborted || quiet) return false;
      setMessage((error as ClientApiError)?.status === 409 ? CONFLICT : "Couldn't save that change. Check your connection and try again.");
      return false;
    } finally {
      if (currentScope.current === admittedScope) { pending.current = null; setFlagSaving(false); setOptimistic({}); }
    }
  }
  const latestSaveFlags = useRef(saveFlags); latestSaveFlags.current = saveFlags;

  // Move this browser's older credit / Ghost voice choice into the profile
  // once per token, and only for flags the profile has not chosen.
  useEffect(() => {
    if (!hydrated || !userId || !isSignedIn) return;
    const key = overlayFlagsMigrationKey(userId, token.token);
    let storage: Storage | null = null;
    try { storage = window.localStorage; if (storage.getItem(key)) return; } catch { return; }
    const markDone = () => { try { storage?.setItem(key, "1"); } catch { /* Re-checked next visit. */ } };
    const legacy = legacyOverlayFlags(server.profile, storage);
    if (!Object.keys(legacy).length) { markDone(); return; }
    void latestSaveFlags.current(legacy, true).then(ok => { if (ok) markDone(); });
    // One attempt per mount of this owner's token; later edits are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, userId, isSignedIn, token.token]);

  const credit = optimistic.credit ?? server.profile.credit ?? true;
  const creditQr = optimistic.creditQr ?? server.profile.creditQr ?? false;
  const ghostVoice = optimistic.ghostVoice ?? server.profile.ghostVoice ?? false;
  const busy = saving || flagSaving || !hydrated;
  const flags = useMemo<OverlayFlags>(() => ({
    credit, creditQr, ghostVoice, busy,
    setCredit: show => { void latestSaveFlags.current({ credit: show }); },
    setCreditQr: show => { void latestSaveFlags.current({ creditQr: show }); },
    setGhostVoice: on => { void latestSaveFlags.current({ ghostVoice: on }); },
  }), [credit, creditQr, ghostVoice, busy]);

  return <OverlayFlagsContext.Provider value={flags}>
    {legacyTheme ? <aside className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-4" aria-label="Previous overlay theme">
      <h2 className="text-body font-semibold">Move your theme to your overlay</h2>
      <p className="text-caption text-text-muted">This browser has a previous theme. Add it to your draft, then Save to update connected sources. Nothing moves automatically.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { change({ ...draft, theme: legacyTheme }); dismissMigration(); }} disabled={saving}>Use previous theme</Button><Button variant="ghost" onClick={dismissMigration}>Dismiss</Button></div>
    </aside> : null}
    {children({ profile: draft, saving: saving || !hydrated, setLayout, setTheme: theme => change({ ...draft, theme }), setDuration: (widget, durationSec) => change({ ...draft, widgetOptions: { ...draft.widgetOptions, [widget]: { durationSec } } }) })}
    {message ? <p role="status" className="rounded-lg border border-border bg-bg-surface p-3 text-caption text-text-muted">{message}</p> : null}
  </OverlayFlagsContext.Provider>;
}
