"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { apiCall } from "@/lib/clientApi";
import { OVERLAY_STARTER_PACKS, overlayStarterPack } from "@/lib/overlayStarterPacks";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { OverlayToken } from "./OverlayTokenHeader";

export function OverlayStarterPacks({ token, onUpdated }: { token: OverlayToken; onUpdated: () => Promise<unknown> }) {
  const { getToken, userId } = useAuth(), router = useRouter(), query = useSearchParams();
  const pack = overlayStarterPack(query.get("pack")), identity = `${userId}:${token.token}:${pack?.id ?? ""}`;
  const current = useRef(identity); current.current = identity;
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setBusy(false); setError(""); return () => { controller.current?.abort(); }; }, [identity]);
  const select = (packId?: string) => { const next = new URLSearchParams(query.toString()); next.set("tab", "overlay"); next.set("section", "widgets"); if (packId) next.set("pack", packId); else next.delete("pack"); router.replace(`/settings?${next}`, { scroll: false }); };
  const apply = async () => {
    if (!pack || busy) return;
    const owner = identity, target = pack, baseline = token.enabledWidgets ?? [], request = new AbortController(); controller.current = request;
    setBusy(true); setError("");
    try {
      const enabled = [...new Set([...baseline, ...target.widgets.filter(widget => !("urlArmed" in widget)).map(widget => widget.id)])];
      await apiCall(async () => { const authToken = await getToken(); if (current.current !== owner || request.signal.aborted) throw new Error("Account changed"); return authToken; }, `/v1/overlay-tokens/${encodeURIComponent(token.token)}/widgets`, { method: "PUT", body: JSON.stringify({ enabled, expectedEnabled: baseline }), signal: request.signal });
      if (current.current !== owner || request.signal.aborted) return;
      await onUpdated(); if (current.current === owner && !request.signal.aborted) select();
    } catch (err) { if (current.current === owner && !request.signal.aborted) setError((err as { status?: number }).status === 409 ? "Widget settings changed in another tab. Refresh the selection, review it and try again." : "Couldn't enable this setup. Your current selection is still available; try again."); }
    finally { if (current.current === owner && !request.signal.aborted) setBusy(false); }
  };
  return <><Card title="Choose a starter pack"><p className="mb-3 text-caption text-text-muted">Review the changes first. Packs keep your other enabled widgets. Browser Sources and platform connections still need your setup.</p><div className="flex flex-wrap gap-2">{OVERLAY_STARTER_PACKS.map(item => <Button key={item.id} variant="secondary" onClick={() => select(item.id)}>{item.name}</Button>)}</div></Card><ConfirmDialog open={!!pack} title={pack ? `Enable ${pack.name.toLowerCase()}?` : "Enable setup?"} onClose={() => { if (!busy) { setError(""); select(); } }} onConfirm={() => void apply()} loading={busy} focusCancel confirmLabel="Enable setup"><ul className="space-y-2 text-caption">{pack?.widgets.map(widget => <li key={widget.id}><strong>{widget.name}</strong> — {"urlArmed" in widget ? "URL enabled; choose a build in Look before copying" : token.enabledWidgets?.includes(widget.id) ? "already enabled" : "will be enabled"}</li>)}</ul>{error ? <p role="alert" className="mt-3 text-caption text-danger">{error}</p> : null}</ConfirmDialog></>;
}
