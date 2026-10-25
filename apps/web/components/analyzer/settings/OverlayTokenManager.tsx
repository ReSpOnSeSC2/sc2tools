"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSettingsContext } from "./SettingsContext";
import type { OverlayToken } from "./OverlayTokenHeader";

export function OverlayTokenManager({ items, selected, onSelect, onRefresh, compact = false }: {
  items: OverlayToken[];
  selected: OverlayToken;
  onSelect: (token: string) => void;
  onRefresh: () => Promise<unknown>;
  compact?: boolean;
}) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const dirty = useSettingsContext().isDirty("overlay");
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"rotate" | "revoke" | null>(null);
  const [draft, setDraft] = useState({ token: selected.token, label: selected.label });
  const label = draft.token === selected.token ? draft.label : selected.label;
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, [owner]);

  async function save(action: "rename" | "rotate" | "revoke" | "mint") {
    if (!owner || operation.current || dirty && action !== "rename") return;
    const controller = new AbortController(); operation.current = controller;
    const active = () => currentOwner.current === owner && operation.current === controller && !controller.signal.aborted;
    setBusy(true); setError(""); setMessage("");
    const scopedToken = async () => {
      if (!active()) throw new Error("Account changed");
      const bearer = await getToken();
      if (!active()) throw new Error("Account changed");
      return bearer;
    };
    try {
      const base = `/v1/overlay-tokens/${encodeURIComponent(selected.token)}`;
      const result = await boundedApiRequest(signal => apiCall<{pending?: boolean; token?: string; unavailable?: boolean; revoked?: boolean}>(scopedToken,
        action === "mint" ? "/v1/overlay-tokens" : action === "rotate" ? `${base}/rotate` : base,
        { method: action === "revoke" ? "DELETE" : action === "rename" ? "PATCH" : "POST", signal,
          ...(action === "revoke" ? {} : { body: JSON.stringify(action === "rename" ? { label } : action === "mint" ? { label: `Token ${items.length + 1}` } : {}) }) }), 15_000, controller.signal);
      if (!active()) return;
      if (result?.token) onSelect(result.token);
      await onRefresh();
      if (!active()) return;
      setDialog(null);
      setMessage(action === "rotate" ? result.unavailable ? result.revoked ? "The replacement was also revoked. Select an active token or create one. Previous URLs remain revoked." : "An active replacement could not be resolved. Select an active token or create one. Previous URLs remain revoked." : result.pending ? "Rotation is paused safely. Continue rotation to finish moving the remaining data." : "Overlay URL replaced. Copy the new URLs below. A connected desktop app with OBS scene switching enabled repairs recognized generated OBS sources; update your other sources and Dock URL manually."
        : action === "revoke" ? "Token revoked. Its URLs no longer work." : action === "mint" ? "Token created. Its URLs are now selected." : "Token renamed.");
    } catch (err) {
      if (!active()) return;
      setError((err as ClientApiError)?.message || "Couldn't save. Retry the same action; an interrupted rotation keeps its reserved replacement and saved data.");
      // A response can be lost after durable progress. Refresh the owner list
      // without treating the browser's timeout as a rollback.
      await onRefresh().catch(() => undefined);
    } finally {
      if (active()) { operation.current = null; setBusy(false); }
    }
  }

  if (!owner) return null;
  return <Card className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label className="min-w-0 text-body font-medium text-text">URLs shown for
        <select className="mt-1 block w-full rounded-md border border-border bg-bg px-3 py-2 text-body" value={selected.token} disabled={busy || !owner || dirty} onChange={event => { setMessage(""); setError(""); onSelect(event.target.value); }}>
          {items.map(item => <option key={item.token} value={item.token}>{item.label} · {item.token.slice(-4)}{item.rotationPending ? " · rotation pending" : ""}</option>)}
        </select>
      </label>
      {!compact ? <Button variant="secondary" disabled={busy || !owner || dirty} onClick={() => void save("mint")}>Mint another token</Button> : null}
    </div>
    {dirty ? <p role="status" className="text-caption text-text-muted">Save or reset your unsaved Overlay edits before switching or rotating tokens.</p> : null}
    {!compact ? <>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-caption text-text-muted">Token label
          <input className="mt-1 block w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text" maxLength={60} value={label} disabled={busy || !!selected.rotationPending} onChange={event => setDraft({ token: selected.token, label: event.target.value })} />
        </label>
        <Button variant="secondary" disabled={busy || !label.trim() || label === selected.label || !!selected.rotationPending} onClick={() => void save("rename")}>Save label</Button>
      </div>
      <p className="text-caption text-text-muted">Each token has its own URLs, widgets, profile and Studio. Rotate a leaked URL to preserve its saved data.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || dirty} loading={busy && dialog === "rotate"} onClick={() => selected.rotationPending ? void save("rotate") : setDialog("rotate")}>{selected.rotationPending ? "Continue rotation" : "Rotate"}</Button>
        <Button variant="danger" disabled={busy || dirty || !!selected.rotationPending} onClick={() => setDialog("revoke")}>Revoke</Button>
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
