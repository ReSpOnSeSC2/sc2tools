"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { QueryState } from "@/components/ui/QueryState";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { DestructiveConfirmDialog } from "@/components/ui/DestructiveConfirmDialog";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useApi, apiCall } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import { AGENT_ONLINE_WINDOW_MS, isAgentVersionAtLeast } from "@/components/dashboard/AgentUpgradeNotice";
import { PairDeviceForm } from "@/components/onboarding/PairDeviceForm";
import { useReleaseInfo } from "@/components/onboarding/useReleaseInfo";
import type { PairedDevice } from "@/components/onboarding/pairingTypes";

function DeviceRowsSkeleton() {
  return <SkeletonRegion label="Loading devices" className="space-y-3">{[0, 1].map((row) => <div key={row} aria-hidden className="space-y-2 rounded-lg border border-border p-4"><SkeletonBar className="h-5 w-48 max-w-full" /><SkeletonBar className="h-4 w-64 max-w-full" /></div>)}</SkeletonRegion>;
}

function failureText(error: unknown, fallback: string) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : fallback;
}

export function DevicesPanel() {
  const { getToken } = useAuth();
  const devices = useApi<{ items: PairedDevice[] }>("/v1/devices", { refreshInterval: 30_000 });
  const release = useReleaseInfo("windows");
  const [now, setNow] = useState(() => Date.now());
  const [unpair, setUnpair] = useState<PairedDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  async function confirmUnpair() {
    if (!unpair || busy) return;
    setBusy(true); setError("");
    try {
      await apiCall(getToken, `/v1/devices/${encodeURIComponent(unpair.deviceId)}`, { method: "DELETE" });
      setNotice(`Unpaired ${unpair.label || unpair.hostname || "PC"}.`); setUnpair(null);
      await devices.mutate();
    } catch (failure) { setError(failureText(failure, "Couldn't unpair this PC. Please try again.")); }
    finally { setBusy(false); }
  }

  return <div className="grid items-start gap-6 md:grid-cols-2">
    <Card title="Link a PC" headingLevel={2}><PairDeviceForm onPaired={() => { void devices.mutate(); }} onConnected={() => { void devices.mutate(); }} /></Card>
    <section className="min-w-0 space-y-3" aria-labelledby="paired-pcs-heading">
      <h2 id="paired-pcs-heading" className="text-h3 font-semibold">Your PCs</h2>
      <QueryState q={devices} skeleton={<DeviceRowsSkeleton />} errorTitle="Couldn't load your PCs" isEmpty={(data) => data.items.length === 0} empty={<EmptyStatePanel title="No PCs paired yet" description="Install SC2 Tools on your gaming PC, then use its code to link it here." action={<Link href="/download" className="text-accent underline">Download the agent</Link>} />}>
        {(data) => <ul className="space-y-3">{data.items.map((device) => <li key={device.deviceId}><DeviceCard device={device} now={now} latest={release.data?.latest} onUnpair={() => { setError(""); setUnpair(device); }} onSaved={() => devices.mutate()} /></li>)}</ul>}
      </QueryState>
      {notice ? <p role="status" className="text-caption text-success">{notice}</p> : null}
      {error && !unpair ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      <LazyHelpLink slug="pairing-troubleshooting">Understand device status and pairing</LazyHelpLink>
    </section>
    <DestructiveConfirmDialog open={Boolean(unpair)} onClose={() => { if (!busy) { setUnpair(null); setError(""); } }} onConfirm={() => { void confirmUnpair(); }} title={<span className="break-all">Unpair {unpair?.label || unpair?.hostname || "this PC"}?</span>} description="This PC will stop syncing until you link it again. Your existing games stay in your account." confirmWord="UNPAIR" confirmLabel="Unpair PC" loading={busy}>
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </DestructiveConfirmDialog>
  </div>;
}

function DeviceCard({ device, now, latest, onUnpair, onSaved }: { device: PairedDevice; now: number; latest?: string; onUnpair: () => void; onSaved: () => unknown }) {
  const { getToken } = useAuth();
  const [label, setLabel] = useState(device.label || "");
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setLabel(device.label || ""); }, [device.label]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
  const age = Math.max(now, Date.now()) - seen;
  const online = Number.isFinite(seen) && age >= 0 && age < AGENT_ONLINE_WINDOW_MS;
  const update = Boolean(latest && device.agentVersion && !isAgentVersionAtLeast(device.agentVersion, latest));
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiCall(getToken, `/v1/devices/${encodeURIComponent(device.deviceId)}`, { method: "PATCH", body: JSON.stringify({ label: label.trim() }) });
      await onSaved(); dirty.current = false; setLabel(label.trim()); setNotice("Label saved.");
    } catch (failure) { setError(failureText(failure, "Couldn't save this label. Please try again.")); }
    finally { setBusy(false); }
  }
  return <Card title={<span className="break-all">{device.label || device.hostname || "Your PC"}</span>} headingLevel={3}>
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2"><Badge variant={online ? "success" : "neutral"}>{online ? "Online" : "Offline"}</Badge>{update ? <Link href="/download" className="text-caption text-accent underline">Update available → v{latest}</Link> : null}</div>
      <p className="break-words text-caption text-text-muted">{[device.hostname, device.agentOsRelease || device.agentOs, device.agentVersion ? `v${device.agentVersion}` : ""].filter(Boolean).join(" · ") || "Waiting for the app to check in"}</p>
      <p className="text-caption text-text-dim">Paired {fmtAgo(device.createdAt)} · {device.lastSeenAt ? `seen ${fmtAgo(device.lastSeenAt)}` : "not seen yet"}</p>
      <form onSubmit={save} className="flex flex-wrap gap-2"><Input aria-label={`Label for ${device.hostname || "PC"}`} value={label} onChange={(event) => { dirty.current = true; setLabel(event.target.value); }} maxLength={40} disabled={busy} placeholder="Optional label" className="min-w-0 flex-1" /><Button size="sm" variant="secondary" type="submit" disabled={busy || label.trim() === (device.label || "")} loading={busy}>Save label</Button></form>
      {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}{notice ? <p role="status" className="text-caption text-success">{notice}</p> : null}
      <Button variant="ghost" size="sm" onClick={onUnpair}>Unpair</Button>
    </div>
  </Card>;
}
