"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { currentSubscription, deviceLabel, endpointKey, pushSupport, subscribeThisDevice } from "@/lib/pwa/push";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { InstantBadge } from "@/components/ui/InstantBadge";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useSaveSource } from "@/components/analyzer/settings/SettingsContext";
import { formatDate, formatDateTime } from "@/lib/i18n/format";

type Device = { id: string; label: string; key: string; createdAt: string; lastOkAt: string | null };
export type PushStatus = { enabled: boolean; publicKey: string | null; groups: string[]; available: Array<{ id: string; label: string }>; devices: Device[] };
type DeviceState = "checking" | "on" | "off" | "denied" | "unsupported" | "ios-install";

/** Settings > Preferences: browser and phone notifications for the bell. */
export function PushPreferences() {
  const { userId } = useAuth();
  return userId ? <PushPreferencesPanel key={userId} /> : null;
}

function PushPreferencesPanel() {
  const { getToken } = useAuth();
  const status = useApi<PushStatus>("/v1/me/push");
  const [device, setDevice] = useState<{ state: DeviceState; key: string | null }>({ state: "checking", key: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientApiError | Error | null>(null);
  const [message, setMessage] = useState("");
  const call = useCallback(<T,>(path: string, init: RequestInit) => apiCall<T>(getToken, path, init), [getToken]);
  const register = useCallback(async (subscription: PushSubscription) => {
    await call("/v1/me/push/subscriptions", { method: "POST", body: JSON.stringify({ ...subscription.toJSON(), label: deviceLabel(navigator.userAgent) }) });
  }, [call]);
  const data = status.data;
  // Latest callbacks in refs: the check below reruns only when the device list changes.
  const latest = useRef({ register, refresh: status.mutate });
  latest.current = { register, refresh: status.mutate };
  useEffect(() => {
    let live = true;
    const show = (state: DeviceState, key: string | null) => setDevice((prev) => (prev.state === state && prev.key === key ? prev : { state, key }));
    const support = pushSupport();
    if (support !== "ok") { show(support, null); return; }
    if (Notification.permission === "denied") { show("denied", null); return; }
    void currentSubscription().then(async (sub) => {
      const key = sub ? await endpointKey(sub.endpoint) : null;
      if (!live) return;
      show(sub ? "on" : "off", key);
      // Self-heal: the browser can replace a subscription on its own.
      if (sub && key && data?.enabled && !data.devices.some((row) => row.key === key)) { await latest.current.register(sub); await latest.current.refresh(); }
    }).catch(() => { if (live) show("off", null); });
    return () => { live = false; };
  }, [data]);

  async function run(work: () => Promise<string | void>): Promise<boolean> {
    if (busy) return false; setBusy(true); setError(null); setMessage("");
    try { const note = await work(); if (note) setMessage(note); await status.mutate(); return true; }
    catch (cause) { setError(cause as Error); return false; }
    finally { setBusy(false); }
  }
  const turnOn = () => run(async () => {
    if (!data?.publicKey) return;
    const result = await subscribeThisDevice(data.publicKey, API_BASE);
    if (!result) { setDevice({ state: Notification.permission === "denied" ? "denied" : "off", key: null }); return "Notifications were not allowed in this browser."; }
    await register(result.subscription);
    setDevice({ state: "on", key: await endpointKey(result.subscription.endpoint) });
    return result.updateWaiting ? "On for this device. SC2 Tools has an update waiting; choose Update in the banner so notifications can appear." : "On for this device.";
  });
  const turnOff = () => run(async () => {
    const sub = await currentSubscription();
    if (sub) { await call("/v1/me/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
    setDevice({ state: "off", key: null });
    return "Off for this device.";
  });

  return <Section id="push" className="scroll-mt-28" title="Phone and browser notifications" description="Get your notifications on this device even when SC2 Tools isn't open. Each browser and phone is turned on separately.">
    {status.error && !data ? <RequestError error={status.error} onRetry={() => status.mutate()} /> : !data ? <Skeleton rows={3} /> : <Card>
      {error ? <RequestError error={error as ClientApiError} onRetry={() => setError(null)} /> : null}
      {!data.enabled ? <p className="text-caption text-text-muted">Push notifications aren&apos;t switched on for SC2 Tools yet. Your notifications still arrive in the bell.</p> : <>
        <ThisDevice state={device.state} busy={busy} onOn={turnOn} onOff={turnOff} />
        {message ? <p role="status" className="mt-2 text-caption text-text-muted">{message}</p> : null}
        <PushGroups status={data} disabled={busy} onSave={(groups) => run(async () => { await call("/v1/me/push/preferences", { method: "PUT", body: JSON.stringify({ groups }) }); return "Push choices saved."; })} />
        <DeviceList devices={data.devices} currentKey={device.key} disabled={busy}
          onRemove={(id) => run(async () => { await call(`/v1/me/push/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }); return "Device removed."; })}
          onTest={() => run(async () => { const res = await call<{ sent: number }>("/v1/me/push/test", { method: "POST", body: "{}" }); return res.sent ? `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.` : "No device accepted the test. Turn notifications on for this device first."; })} />
      </>}
      <p className="mt-4 text-caption text-text-muted">On iPhone or iPad, add SC2 Tools to your Home Screen first (Share, then Add to Home Screen), open it from there, then turn notifications on. <LazyHelpLink slug="notifications-on-your-phone">Notifications on your phone</LazyHelpLink></p>
    </Card>}
  </Section>;
}

function ThisDevice({ state, busy, onOn, onOff }: { state: DeviceState; busy: boolean; onOn: () => void; onOff: () => void }) {
  const text: Record<DeviceState, string> = {
    checking: "Checking this browser…", on: "On for this device.", off: "Off for this device.",
    denied: "This browser blocks notifications from SC2 Tools. Allow them in the browser's site settings, then reload.",
    unsupported: "This browser can't receive push notifications.", "ios-install": "Add SC2 Tools to your Home Screen to get notifications on this device.",
  };
  return <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <p className="text-body text-text">{text[state]} {state === "on" || state === "off" ? <InstantBadge /> : null}</p>
    {state === "off" ? <Button className="min-h-11" disabled={busy} onClick={onOn}>Turn on for this device</Button> : null}
    {state === "on" ? <Button variant="secondary" className="min-h-11" disabled={busy} onClick={onOff}>Turn off for this device</Button> : null}
  </div>;
}

function PushGroups({ status, disabled, onSave }: { status: PushStatus; disabled: boolean; onSave: (groups: string[]) => Promise<boolean> }) {
  const form = useDirtyForm(status.groups, []);
  useSaveSource("preferences", {
    label: "push choices", dirty: form.dirty, order: 4, reset: form.reset,
    save: async () => {
      const saved = await onSave(form.draft);
      if (saved) form.markSaved();
      return saved;
    },
  }, "push-choices");
  return <fieldset className="mt-4 border-t border-border pt-4" disabled={disabled}>
    <legend className="text-body font-semibold text-text">What to push</legend>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">{status.available.map((group) => <label key={group.id} className="flex min-h-11 items-center gap-2 text-caption">
      <input type="checkbox" checked={form.draft.includes(group.id)} onChange={(e) => form.setDraft((list) => e.target.checked ? [...list, group.id] : list.filter((id) => id !== group.id))} />{group.label}
    </label>)}</div>
  </fieldset>;
}

function DeviceList({ devices, currentKey, disabled, onRemove, onTest }: { devices: Device[]; currentKey: string | null; disabled: boolean; onRemove: (id: string) => void; onTest: () => void }) {
  return <div className="mt-4 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-body font-semibold text-text">Devices</h3>
      <Button variant="secondary" size="sm" className="min-h-11" disabled={disabled || devices.length === 0} onClick={onTest}>Send a test</Button>
    </div>
    {devices.length === 0 ? <p className="mt-2 text-caption text-text-muted">No devices yet.</p> : <ul className="mt-2 divide-y divide-border">{devices.map((row) => <li key={row.id} className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0"><p className="text-caption font-semibold text-text">{row.label} {row.key === currentKey ? <Badge variant="success">This device</Badge> : null}</p>
        <p className="text-caption text-text-muted">{row.lastOkAt ? `Last delivered ${formatDateTime(new Date(row.lastOkAt))}` : `Added ${formatDate(new Date(row.createdAt))}`}</p></div>
      <Button variant="secondary" size="sm" className="min-h-11" disabled={disabled} onClick={() => onRemove(row.id)} aria-label={`Remove ${row.label}`}>Remove</Button>
    </li>)}</ul>}
  </div>;
}
