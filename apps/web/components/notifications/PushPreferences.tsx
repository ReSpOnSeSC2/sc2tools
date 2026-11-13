"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, apiCall, useApi, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
import { checkPushWorker, currentSubscription, deviceLabel, endpointKey, hasPushKey, isReadyWorker, pushSupport, subscribeThisDevice, type PushWorkerCheck } from "@/lib/pwa/push";
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
type DeviceState = "checking" | "on" | "off" | "denied" | "unsupported" | "ios-install" | "update" | "retry" | "reset";
type ReadyWorker = Extract<PushWorkerCheck, { state: "ready" }>;
type ThisBrowser = { state: DeviceState; key: string | null; ready?: ReadyWorker; subscription?: PushSubscription | null };

/** Settings > Preferences: browser and phone notifications for the bell. */
export function PushPreferences() {
  const { userId } = useAuth();
  return userId ? <PushPreferencesPanel key={userId} owner={userId} /> : null;
}

function useThisBrowser(data: PushStatus | undefined) {
  const [device, setDevice] = useState<ThisBrowser>({ state: "checking", key: null });
  const [revision, setRevision] = useState(0);
  const checkAgain = () => { setDevice({ state: "checking", key: null }); setRevision((value) => value + 1); };
  useEffect(() => {
    if (!data?.enabled || !data.publicKey) return;
    let live = true;
    void checkThisBrowser(data.devices, data.publicKey).then((state) => { if (live) setDevice(state); });
    return () => { live = false; };
  }, [data, revision]);
  return { device, setDevice, checkAgain };
}

function usePushAction(refresh: () => Promise<unknown>) {
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientApiError | Error | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => () => operation.current?.abort(), []);

  async function run(work: (signal: AbortSignal) => Promise<string | void>): Promise<boolean> {
    if (operation.current) return false;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(null); setMessage("");
    try {
      const note = await work(controller.signal);
      controller.signal.throwIfAborted();
      if (note) setMessage(note);
      await refresh();
      return !controller.signal.aborted;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause as Error);
      return false;
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { run, busy, error, message, clearError: () => setError(null) };
}

function useBrowserActions(data: PushStatus | undefined, call: (path: string, init: RequestInit) => Promise<unknown>) {
  const { device, setDevice, checkAgain } = useThisBrowser(data);
  const remove = (id: string, signal: AbortSignal) =>
    call(`/v1/me/push/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE", signal });

  async function turnOn(signal: AbortSignal) {
    if (!data?.publicKey || !device.ready) return;
    if (!isReadyWorker(device.ready)) { checkAgain(); return; }
    const subscription = await subscribeThisDevice(device.ready, device.subscription ?? null, data.publicKey, API_BASE, signal);
    if (!subscription) {
      checkAgain();
      return "Notifications were not allowed in this browser.";
    }
    const key = await endpointKey(subscription.endpoint);
    signal.throwIfAborted();
    setDevice({ ...device, subscription });
    await call("/v1/me/push/subscriptions", { method: "POST", signal,
      body: JSON.stringify({ ...subscription.toJSON(), label: deviceLabel(navigator.userAgent) }) });
    signal.throwIfAborted();
    setDevice({ state: "on", key, subscription });
    return "Notifications are on for this device.";
  }

  async function turnOff(signal: AbortSignal, reset = false) {
    const row = data?.devices.find((entry) => entry.key === device.key);
    if (row) await remove(row.id, signal);
    signal.throwIfAborted();
    if (reset) await device.subscription?.unsubscribe();
    signal.throwIfAborted();
    // The browser can keep its grant while this account stops receiving alerts.
    checkAgain();
    return reset ? "Device reset. Turn on notifications again when ready." : "Notifications are off for this device.";
  }
  return { device, checkAgain, turnOn, turnOff, remove };
}

function PushPreferencesPanel({ owner }: { owner: string }) {
  const { getToken } = useAuth();
  const runOwned = useOwnerRequestScope(owner, getToken);
  const call = <T,>(path: string, init: RequestInit) =>
    runOwned(owner, (token, signal) => apiCall<T>(token, path, { ...init, signal }), undefined, init.signal);
  const status = useApi<PushStatus>("/v1/me/push");
  const data = status.data;
  const { device, checkAgain, turnOn, turnOff, remove } = useBrowserActions(data, call);
  const { run, busy, error, message, clearError } = usePushAction(status.mutate);
  const retryDevice = () => { clearError(); checkAgain(); };

  return <Section id="push" className="scroll-mt-28" title="Phone and browser notifications" description="Get your notifications on this device even when SC2 Tools isn't open. Each browser and phone is turned on separately.">
    {status.error && !data ? <RequestError error={status.error} onRetry={() => status.mutate()} /> : !data ? <Skeleton rows={3} /> : <Card>
      {error ? <RequestError error={error as ClientApiError} onRetry={retryDevice} /> : null}
      {!data.enabled ? <p className="text-caption text-text-muted">Push notifications aren&apos;t switched on for SC2 Tools yet. Your notifications still arrive in the bell.</p> : <>
        <ThisDevice state={device.state} busy={busy} onOn={() => run(turnOn)} onOff={() => run(turnOff)}
          onRetry={retryDevice} onReset={() => run((signal) => turnOff(signal, true))} />
        {message ? <p role="status" className="mt-2 text-caption text-text-muted">{message}</p> : null}
        <PushGroups status={data} disabled={busy} onSave={(groups) => run(async (signal) => { await call("/v1/me/push/preferences", { method: "PUT", signal, body: JSON.stringify({ groups }) }); return "Push choices saved."; })} />
        <DeviceList devices={data.devices} currentKey={device.key} disabled={busy}
          onRemove={(id) => run(async (signal) => { await remove(id, signal); return "Device removed."; })}
          onTest={() => run(async (signal) => { const res = await call<{ sent: number }>("/v1/me/push/test", { method: "POST", signal, body: "{}" }); return res.sent ? `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.` : "No device accepted the test. Turn notifications on for this device first."; })} />
      </>}
      <p className="mt-4 text-caption text-text-muted">On iPhone or iPad, add SC2 Tools to your Home Screen first (Share, then Add to Home Screen), open it from there, then turn notifications on. <LazyHelpLink slug="notifications-on-your-phone">Notifications on your phone</LazyHelpLink></p>
    </Card>}
  </Section>;
}

async function checkThisBrowser(devices: Device[], publicKey: string): Promise<ThisBrowser> {
  const support = pushSupport();
  if (support !== "ok") return { state: support, key: null };
  if (Notification.permission === "denied") return { state: "denied", key: null };
  try {
    const subscription = await currentSubscription();
    const key = subscription ? await endpointKey(subscription.endpoint) : null;
    if (subscription && !hasPushKey(subscription, publicKey)) return { state: "reset", key, subscription };
    if (key && devices.some((row) => row.key === key)) return { state: "on", key, subscription };
    const ready = await checkPushWorker();
    return ready.state === "ready" ? { state: "off", key: null, ready, subscription } : { state: ready.state, key: null };
  } catch { return { state: "retry", key: null }; }
}

function ThisDevice({ state, busy, onOn, onOff, onRetry, onReset }: {
  state: DeviceState; busy: boolean; onOn: () => void; onOff: () => void; onRetry: () => void; onReset: () => void;
}) {
  const text: Record<DeviceState, string> = {
    checking: "Checking this browser…", on: "On for this device.", off: "Off for this device.",
    denied: "This browser blocks notifications from SC2 Tools. Allow them in the browser's site settings, then reload.",
    unsupported: "This browser can't receive push notifications.", "ios-install": "Add SC2 Tools to your Home Screen to get notifications on this device.",
    update: "Install the available SC2 Tools update, then check this device again.",
    retry: "This device could not be checked. Make sure you’re online and SC2 Tools is up to date.",
    reset: "This device uses an older notification key. Reset it before turning on notifications.",
  };
  const actions: Partial<Record<DeviceState, { label: string; click: () => void }>> = {
    off: { label: "Turn on for this device", click: onOn },
    on: { label: "Turn off for this device", click: onOff },
    update: { label: "Check this device again", click: onRetry },
    retry: { label: "Check this device again", click: onRetry },
    reset: { label: "Reset notifications on this device", click: onReset },
  };
  const action = actions[state];
  return <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <p role="status" className="text-body text-text">{text[state]} {state === "on" || state === "off" ? <InstantBadge /> : null}</p>
    {action && <Button variant={state === "off" ? "primary" : "secondary"} className="min-h-11" disabled={busy} onClick={action.click}>{action.label}</Button>}
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
  return <fieldset className="mt-4 border-t border-border pt-4" disabled={disabled || !form.hydrated}>
    <legend className="text-body font-semibold text-text">What to push</legend>
    <p className="mt-1 text-caption text-text-muted">Choose what can alert your devices. Open the bell to read each notification.</p>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">{status.available.map((group) => <label key={group.id} className="flex min-h-11 items-center gap-2 text-caption">
      <input type="checkbox" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        checked={form.draft.includes(group.id)} onChange={(e) => form.setDraft((list) => e.target.checked ? [...list, group.id] : list.filter((id) => id !== group.id))} />
      {group.label}
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
