"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSettingsContext } from "./SettingsContext";
import type { OverlayToken } from "./OverlayTokenHeader";

/** Local confirmation after a real ACK, never an API body or persisted token. */
export type OverlayTokenConfirmation = {
  action: "mint" | "rotate" | "revoke";
  predecessor: string;
  returnedToken?: string;
  ambiguity: object;
};

export function OverlayTokenManager({ items, selected, onSelect, onRefresh, compact = false, onBusyChange, onUnknownOutcome, onMutationDispatched, statusPending = false }: {
  items: OverlayToken[];
  selected: OverlayToken;
  onSelect: (token: string) => void;
  onRefresh: (preferred?: string, gate?: boolean, confirmation?: OverlayTokenConfirmation) => Promise<unknown>;
  compact?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onUnknownOutcome?: () => void;
  onMutationDispatched?: (predecessor: string) => object | void;
  statusPending?: boolean;
}) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const settings = useSettingsContext();
  const dirty = settings.isDirty("overlay") || settings.isDirty("chat");
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const scope = useMemo(() => ({ owner, token: selected.token, pending: !!selected.rotationPending, active: true }), [owner, selected.token, selected.rotationPending]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const pendingRef = useRef(statusPending); pendingRef.current = statusPending;
  const operation = useRef<AbortController | null>(null);
  const busyPublisher = useRef(onBusyChange); busyPublisher.current = onBusyChange;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"rotate" | "revoke" | null>(null);
  const [draft, setDraft] = useState({ token: selected.token, label: selected.label });
  const label = draft.token === selected.token ? draft.label : selected.label;
  useEffect(() => {
    scope.active = true; setDialog(null); setBusy(false);
    return () => { scope.active = false; operation.current?.abort(); operation.current = null; busyPublisher.current?.(false); };
  }, [scope]);

  async function save(action: "rename" | "rotate" | "revoke" | "mint") {
    if (!owner || !scope.active || currentScope.current !== scope || operation.current || pendingRef.current || dirtyRef.current && action !== "rename") return;
    const controller = new AbortController(); operation.current = controller;
    const active = () => scope.active && currentScope.current === scope && operation.current === controller && !controller.signal.aborted;
    let dispatched = false;
    let ambiguity: object | void = undefined;
    setBusy(true); if (action !== "rename") onBusyChange?.(true); setError(""); setMessage("");
    const scopedToken = async () => {
      if (!active()) throw new Error("Account changed");
      const bearer = await getToken();
      if (!active()) throw new Error("Account changed");
      dispatched = true;
      if (action !== "rename") ambiguity = onMutationDispatched?.(selected.token);
      return bearer;
    };
    try {
      const base = `/v1/overlay-tokens/${encodeURIComponent(selected.token)}`;
      const result = await boundedApiRequest(signal => apiCall<{pending?: boolean; token?: string; unavailable?: boolean; revoked?: boolean}>(scopedToken,
        action === "mint" ? "/v1/overlay-tokens" : action === "rotate" ? `${base}/rotate` : base,
        { method: action === "revoke" ? "DELETE" : action === "rename" ? "PATCH" : "POST", signal,
          ...(action === "revoke" ? {} : { body: JSON.stringify(action === "rename" ? { label } : action === "mint" ? { label: `Token ${items.length + 1}` } : {}) }) }), 15_000, controller.signal);
      if (!active()) return;
      const returnedToken = typeof result?.token === "string" && result.token.length > 0 && result.token.trim() === result.token ? result.token : undefined;
      // Reaching this line is the real successful DELETE 204/null ACK too.
      // Only this still-current operation may ask its owner to confirm it.
      await onRefresh(returnedToken, action !== "rename", action !== "rename" && ambiguity ? {
        action, predecessor: selected.token, returnedToken, ambiguity,
      } : undefined);
      if (!active()) return;
      // The shared owner selects only a token admitted by the fresh list.
      // Standalone consumers can retain their selector callback contract.
      if (result?.token && !onBusyChange) onSelect(result.token);
      setDialog(null);
      setMessage(action === "rotate" ? result.unavailable ? result.revoked ? "The replacement was also revoked. Select an active token or create one. Previous URLs remain revoked." : "An active replacement could not be resolved. Select an active token or create one. Previous URLs remain revoked." : result.pending ? "Rotation is paused safely. Continue rotation to finish moving the remaining data." : "Overlay URL replaced. Copy the new URLs below. A connected desktop app with OBS scene switching enabled repairs recognized generated OBS sources; update your other sources and Dock URL manually."
        : action === "revoke" ? "Token revoked. Its URLs no longer work." : action === "mint" ? "Token created. Its URLs are now selected." : "Token renamed.");
    } catch (err) {
      if (!active()) return;
      if (dispatched && action !== "rename") onUnknownOutcome?.();
      setError((err as ClientApiError)?.message || "Couldn't confirm the change. Check token status first; an interrupted rotation keeps its reserved replacement and saved data.");
      // A response can be lost after durable progress. Refresh the owner list
      // without treating the browser's timeout as a rollback.
      await onRefresh().catch(() => undefined);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (scope.active && currentScope.current === scope) setBusy(false);
        onBusyChange?.(false);
      }
    }
  }

  if (!owner) return null;
  return <Card className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label className="min-w-0 text-body font-medium text-text">URLs shown for
        <select className="mt-1 block w-full rounded-md border border-border bg-bg px-3 py-2 text-body" value={selected.token} disabled={busy || statusPending || !owner || dirty} onChange={event => { if (operation.current || dirtyRef.current || pendingRef.current || currentScope.current !== scope || !scope.active) return; setMessage(""); setError(""); onSelect(event.target.value); }}>
          {items.map(item => <option key={item.token} value={item.token}>{item.label} · {item.token.slice(-4)}{item.rotationPending ? " · rotation pending" : ""}</option>)}
        </select>
      </label>
      {!compact ? <Button variant="secondary" disabled={busy || statusPending || !owner || dirty} onClick={() => void save("mint")}>Mint another token</Button> : null}
    </div>
    {dirty ? <p role="status" className="text-caption text-text-muted">Save or reset your unsaved Overlay or Chat & alerts edits before switching or rotating tokens.</p> : null}
    {!compact ? <>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-caption text-text-muted">Token label
          <input className="mt-1 block w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text" maxLength={60} value={label} disabled={busy || statusPending || !!selected.rotationPending} onChange={event => setDraft({ token: selected.token, label: event.target.value })} />
        </label>
        <Button variant="secondary" disabled={busy || statusPending || !label.trim() || label === selected.label || !!selected.rotationPending} onClick={() => void save("rename")}>Save label</Button>
      </div>
      <p className="text-caption text-text-muted">Each token has its own URLs, widgets, profile and Studio. Rotate a leaked URL to preserve its saved data.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || statusPending || dirty} loading={busy && dialog === "rotate"} onClick={() => selected.rotationPending ? void save("rotate") : setDialog("rotate")}>{selected.rotationPending ? "Continue rotation" : "Rotate"}</Button>
        <Button variant="danger" disabled={busy || statusPending || dirty || !!selected.rotationPending} onClick={() => setDialog("revoke")}>Revoke</Button>
      </div>
      <Link href="/help/overlay-url-leaked" className="text-caption text-accent-cyan underline">My overlay URL leaked</Link>
    </> : null}
    {message ? <p role="status" className="text-body text-text">{message}</p> : null}
    {error ? <p role="alert" className="text-body text-danger">{error}</p> : null}
    <ConfirmDialog open={dialog === "rotate"} onClose={() => { if (!busy) setDialog(null); }} onConfirm={() => void save("rotate")} title={`Rotate “${selected.label}”?`} confirmLabel="Rotate and preserve data" loading={busy}>
      <p className="text-body text-text">The old URLs stop working. The replacement keeps:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-text-muted"><li>Token label, enabled widgets and profile</li><li>Goals, poll, highlight, timer, scenes and b-roll</li><li>Viewer XP, oracle scores, predictions and clip moments</li><li>Your account&apos;s sounds and alert media references</li></ul>
      <p className="mt-3 text-caption text-text-muted">Update OBS Browser Source and Dock URLs afterward. With OBS scene switching enabled, a connected desktop app can repair recognized generated sources when it next fetches configuration. Custom sources need a manual update. Interrupted rotations can be continued safely.</p>
    </ConfirmDialog>
    <ConfirmDialog open={dialog === "revoke"} onClose={() => { if (!busy) setDialog(null); }} onConfirm={() => void save("revoke")} title={`Revoke “${selected.label}”?`} confirmLabel="Revoke permanently" intent="danger" focusCancel loading={busy} description="Its URLs stop working immediately. Viewer XP and oracle scores stay with the revoked token and are lost to any new token. Choose Rotate to preserve them." />
  </Card>;
}
