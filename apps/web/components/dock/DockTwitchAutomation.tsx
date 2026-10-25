"use client";
import { useEffect, useRef, useState } from "react";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { twitchCurrent, twitchReason, TWITCH_STATE_LABELS, type TwitchCurrent } from "@/lib/twitchAutomation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DockButton } from "./DockControls";

type Snapshot = { current: TwitchCurrent | null; reason: string | null; serverEnabled: boolean; predictionsEnabled: boolean; markersEnabled: boolean };
type Scope = { active: boolean; controller: AbortController | null; busy: boolean };
export function DockTwitchAutomation({ token, onInvalid }: { token: string; onInvalid?: (replaced?: boolean) => void }) {
  return <ActiveTwitchControls key={token} token={token} onInvalid={onInvalid} />;
}
function ActiveTwitchControls({ token, onInvalid }: { token: string; onInvalid?: (replaced?: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{ action: "resolve" | "cancel"; gameKey: string } | null>(null);
  const scopeRef = useRef<Scope | null>(null), invalidRef = useRef(onInvalid); invalidRef.current = onInvalid;
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const scope: Scope = { active: true, controller: null, busy: false }; scopeRef.current = scope;
    const refresh = async () => {
      if (!scope.active || scope.busy) return;
      scope.busy = true; const controller = new AbortController(); scope.controller = controller;
      try {
        const body = await boundedApiRequest(async signal => {
          const response = await fetch(`${API_BASE}/v1/multichat/${encodeURIComponent(token)}/twitch-automation`, { signal, cache: "no-store" });
          if (!response.ok) throw await buildApiError(response);
          return response.json() as Promise<Record<string, unknown>>;
        }, 20_000, controller.signal);
        if (!scope.active || scopeRef.current !== scope || controller.signal.aborted) return;
        setSnapshot({ current: twitchCurrent(body.current), reason: typeof body.reason === "string" ? body.reason : null, serverEnabled: body.serverEnabled === true,
          predictionsEnabled: body.predictionsEnabled === true, markersEnabled: body.markersEnabled === true }); setError("");
      } catch (failure) {
        if (!scope.active || scopeRef.current !== scope || controller.signal.aborted) return;
        const detail = failure as { status?: number; code?: string; message?: string };
        if (detail.status === 401) invalidRef.current?.(detail.code === "overlay_token_replaced");
        setError(detail.message || "Twitch prediction status is unavailable.");
      } finally { if (scope.active && scopeRef.current === scope) scope.busy = false; }
    };
    refreshRef.current = () => { void refresh(); }; void refresh();
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => { scope.active = false; scope.controller?.abort(); clearInterval(timer); };
  }, [token]);
  async function act() {
    const scope = scopeRef.current, selected = confirm;
    if (!scope?.active || scope.busy || !selected || !snapshot?.serverEnabled) return;
    scope.busy = true; setBusy(true); setError(""); setNotice(""); const controller = new AbortController(); scope.controller = controller;
    try {
      const body = await boundedApiRequest(async signal => {
        const response = await fetch(`${API_BASE}/v1/multichat/${encodeURIComponent(token)}/twitch-automation`, { method: "POST", signal, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...selected, confirmed: true }) });
        if (!response.ok) throw await buildApiError(response);
        return response.json() as Promise<Record<string, unknown>>;
      }, 20_000, controller.signal);
      if (!scope.active || scopeRef.current !== scope || controller.signal.aborted) return;
      const current = twitchCurrent(body.current);
      if (!current || current.gameKey !== selected.gameKey) throw new Error("Twitch did not confirm this prediction. Refresh its status.");
      setSnapshot(previous => previous ? { ...previous, current } : previous); setConfirm(null);
      setNotice(current.prediction === "canceled" ? "Twitch confirmed cancellation and refunded the prediction."
        : current.prediction === "resolved" ? "Twitch reports this prediction is resolved."
          : "Your request is recorded. Waiting for Twitch to confirm its final state.");
    } catch (failure) {
      if (!scope.active || scopeRef.current !== scope || controller.signal.aborted) return;
      const detail = failure as { status?: number; code?: string; message?: string };
      if (detail.status === 401) invalidRef.current?.(detail.code === "overlay_token_replaced");
      setError(detail.message || "Twitch did not confirm this operation. Refresh status before retrying.");
    } finally { if (scope.active && scopeRef.current === scope) { scope.busy = false; setBusy(false); } }
  }
  const current = snapshot?.current;
  return <section aria-label="Twitch prediction controls" className="min-w-0 space-y-2 rounded border border-border p-3">
    <h3 className="text-caption font-semibold">Twitch Channel Points</h3>
    <p role="status" className="text-caption">{current ? `Prediction · ${TWITCH_STATE_LABELS[current.prediction]}` : snapshot ? "No Twitch prediction is open." : "Checking Twitch prediction…"}</p>
    {snapshot?.reason ? <p className="text-caption text-text-muted">{twitchReason(snapshot.reason)}</p> : null}
    {current?.reason ? <p className="text-caption text-text-muted">{twitchReason(current.reason)}</p> : null}
    {current?.prediction === "unknown" && !current.canCancel && current.reason !== "prediction_account_changed" ? <p className="text-caption text-text-muted">The prediction ID was not confirmed. Check the Twitch dashboard manually; this Dock cannot safely refund it.</p> : null}
    {!current && snapshot?.predictionsEnabled ? <p className="text-caption text-text-muted">{twitchReason("ranked_status_unavailable")}</p> : null}
    {snapshot ? <p className="text-caption text-text-muted">Start markers · {snapshot.markersEnabled ? current?.marker === "created" ? "Added" : current?.marker === "error" ? "Unavailable" : current?.marker === "unknown" ? "Unconfirmed" : "On" : "Off"}</p> : null}
    <div className="flex flex-wrap gap-2"><DockButton disabled={busy} onClick={() => refreshRef.current()}>Refresh Twitch</DockButton>
      {current?.canResolve ? <DockButton disabled={busy || !snapshot?.serverEnabled} onClick={() => setConfirm({ action: "resolve", gameKey: current.gameKey })}>Resolve verified result</DockButton> : null}
      {current?.canCancel ? <DockButton disabled={busy || !snapshot?.serverEnabled} onClick={() => setConfirm({ action: "cancel", gameKey: current.gameKey })}>Cancel / refund</DockButton> : null}</div>
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}{notice ? <p role="status" className="text-caption">{notice}</p> : null}
    <ConfirmDialog open={confirm !== null} focusCancel loading={busy} title={confirm?.action === "cancel" ? "Cancel Twitch prediction?" : "Resolve Twitch prediction?"}
      description={confirm?.action === "cancel" ? "Request cancellation and a Channel Points refund. Twitch must confirm it before this Dock reports a refund." : "Use the stored replay-verified result. You cannot choose or override its outcome here."}
      confirmLabel={confirm?.action === "cancel" ? "Request refund" : "Resolve verified result"} onClose={() => { if (!busy) setConfirm(null); }} onConfirm={() => void act()} />
  </section>;
}
