"use client";

import { Suspense, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { apiCall } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import { normalizePairingCode, PAIRING_CODE_LOCATION, type PairedDevice, type PairingInfo } from "./pairingTypes";

interface Props { compact?: boolean; onPaired?: () => void; onConnected?: () => void }

/** Reading the browser query stays behind Suspense on statically rendered pages. */
export function PairDeviceForm(props: Props) {
  const { userId } = useAuth();
  return <Suspense fallback={<p role="status">Loading pairing form…</p>}><PairForm key={userId || "signed-out"} {...props} /></Suspense>;
}

function PairForm({ compact = false, onPaired, onConnected }: Props) {
  const { getToken } = useAuth();
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const inputId = useId();
  const [code, setCode] = useState(() => normalizePairingCode(params.get("code") || ""));
  const [preview, setPreview] = useState<PairingInfo | null>(null);
  const [claimed, setClaimed] = useState<PairingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [late, setLate] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const typed = useRef(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  const cancelRequest = useRef<(() => void) | null>(null);
  const onPairedRef = useRef(onPaired); onPairedRef.current = onPaired;
  const onConnectedRef = useRef(onConnected); onConnectedRef.current = onConnected;
  const getTokenRef = useRef(getToken); getTokenRef.current = getToken;
  useEffect(() => { active.current = true; return () => { active.current = false; cancelRequest.current?.(); }; }, []);
  useEffect(() => { if (typed.current && code.length === 6) action.current?.focus(); }, [code]);
  useEffect(() => {
    if (!claimed) return;
    const controller = new AbortController();
    const deadline = Date.now() + 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const stop = setTimeout(() => { controller.abort(); if (active.current) setLate(true); }, 60_000);
    async function check() {
      try {
        const result = await apiCall<{ items: PairedDevice[] }>(getTokenRef.current, "/v1/devices", { signal: controller.signal });
        const device = result.items.find((item) => item.deviceId === claimed!.device.deviceId && item.lastSeenAt);
        if (device && active.current && !controller.signal.aborted) {
          setConfirmation(`Connected: ${device.label || device.hostname || "Your PC"}${device.agentVersion ? `, v${device.agentVersion}` : ""}`);
          onConnectedRef.current?.();
          clearTimeout(stop); return;
        }
      } catch { /* A short outage keeps the bounded confirmation poll running. */ }
      if (!controller.signal.aborted && Date.now() < deadline) timer = setTimeout(check, 3000);
    }
    timer = setTimeout(check, 3000);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(stop); };
  }, [claimed]);

  async function requestPairing(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancelRequest.current = () => { controller.abort(); reject(new Error("Pairing request cancelled.")); };
      timer = setTimeout(() => {
        controller.abort(); reject(new Error("The link request timed out. Check your connection and try again."));
      }, 15_000);
    });
    try { return await Promise.race([apiCall<PairingInfo>(getToken, path, { ...init, signal: controller.signal }), deadline]); }
    finally { clearTimeout(timer!); cancelRequest.current = null; }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || busy || !/^\d{6}$/.test(code)) return;
    inFlight.current = true;
    setError(""); setBusy(true);
    try {
      if (!preview) {
        const result = await requestPairing(`/v1/device-pairings/${code}/preview`);
        if (active.current) setPreview(result);
      } else {
        const result = await requestPairing("/v1/device-pairings/claim", { method: "POST", body: JSON.stringify({ code }) });
        if (!active.current) return;
        setClaimed(result); setLate(false); setCode("");
        const remaining = new URLSearchParams(params.toString()); remaining.delete("code");
        router.replace(`${pathname || "/devices"}${remaining.size ? `?${remaining}` : ""}`, { scroll: false });
        gaEvent("device_paired"); onPairedRef.current?.();
      }
    } catch (failure) {
      if (active.current) { setPreview(null); setError(failure instanceof Error || (failure && typeof failure === "object" && "message" in failure) ? String(failure.message) : "Couldn't link this PC. Please try again."); }
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }

  if (claimed) return <div className="space-y-2"><p role="status" className="text-success">{confirmation || (late ? "Paired — waiting for the app to check in" : "Paired — checking the app connection…")}</p>{late ? <LazyHelpLink slug="pairing-troubleshooting">Help with the connection</LazyHelpLink> : null}</div>;
  const name = preview?.device.hostname || "this PC";
  const details = [preview?.device.os, preview?.device.version ? `v${preview.device.version}` : ""].filter(Boolean).join(", ");
  return <form onSubmit={submit} className={compact ? "space-y-3" : "space-y-4"}>
    <p className="text-caption text-text-muted">Enter the 6-digit code {PAIRING_CODE_LOCATION}.</p>
    <label htmlFor={inputId} className="block text-caption font-medium text-text">Pairing code</label>
    <Input id={inputId} value={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" disabled={busy} aria-label="6-digit pairing code" onChange={(event) => { typed.current = true; setPreview(null); setError(""); setCode(normalizePairingCode(event.target.value)); }} className="font-mono text-2xl tracking-widest" />
    {preview ? <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-3"><p className="break-all font-medium">Link {name}{details ? ` (${details})` : ""}?</p>{!preview.sameNetwork ? <p className="text-caption text-warning">Only pair a code shown by SC2 Tools on your own PC.</p> : null}</div> : null}
    <Button ref={action} type="submit" className="max-w-full" disabled={busy || code.length !== 6} loading={busy}><span className="min-w-0 break-all">{preview ? `Link ${name}` : "Link this PC"}</span></Button>
    {preview ? <Button variant="ghost" type="button" disabled={busy} onClick={() => setPreview(null)}>Use another code</Button> : null}
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
    <div className="flex flex-wrap gap-3 text-caption"><LazyHelpLink slug="install-and-pair">Install and link the desktop app</LazyHelpLink><LazyHelpLink slug="pairing-troubleshooting">Pairing problems</LazyHelpLink></div>
  </form>;
}
