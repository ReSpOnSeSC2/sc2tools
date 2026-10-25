"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest, useApi } from "@/lib/clientApi";

type Device = { id: string; label: string; supported: boolean; enabled: boolean };
const MESSAGES: Record<string, string> = {
  added: "Source added to your current OBS program scene.", already_present: "This source is already in your current OBS program scene.",
  declined: "Cancelled on the desktop agent. No source was added.", disabled: "Enable website OBS requests in the desktop agent, then try again.",
  scene_changed: "The OBS program scene changed. Review the current scene and try again.",
  expired: "The local confirmation expired. Inspect OBS before trying again.", owner_changed: "The desktop account or OBS settings changed. Review them before trying again.",
};

/** One availability request for the entire widget list; never one per card. */
export function useObsAddSource() {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const current = useRef(owner); current.current = owner;
  const active = useRef<AbortController | null>(null);
  const [deviceId, setDeviceId] = useState(""), [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState("");
  const availability = useApi<{ devices: Device[] }>(owner ? "/v1/devices/obs" : null, { refreshInterval: 30000, revalidateOnFocus: true }, { timeoutMs: 10000 });
  const devices = owner && !availability.isPreviousData ? availability.data?.devices ?? [] : [];
  const eligible = devices.filter(device => device.supported && device.enabled);
  const selected = eligible.length === 1 ? eligible[0]?.id : eligible.some(device => device.id === deviceId) ? deviceId : "";
  useLayoutEffect(() => {
    setDeviceId(""); setBusy(null); setMessage("");
    return () => { active.current?.abort(); active.current = null; };
  }, [owner]);
  const reason = !owner ? "Sign in to add a source." : availability.error ? "Couldn’t check the desktop agent. Retry the connection check." : !availability.data ? "Checking your desktop agent…" : !devices.length ? "Open your paired desktop agent to add a source." : !eligible.length ? "Enable website OBS requests in an updated desktop agent." : !selected ? "Choose a desktop agent first." : busy ? "Finish the pending desktop confirmation first." : "";
  const add = async (widget: string) => {
    if (!owner || !selected || reason || active.current) return;
    const captured = owner, request = new AbortController(); active.current = request;
    setBusy(widget); setMessage("Confirm Add source in your desktop agent. Cancel is selected by default.");
    try {
      const reply = await boundedApiRequest(signal => apiCall<{ code: string }>(async () => {
        const token = await getToken();
        if (current.current !== captured || active.current !== request) throw new Error("Account changed");
        signal.throwIfAborted(); return token;
      }, "/v1/devices/obs/add-source", { method: "POST", body: JSON.stringify({ widget, deviceId: selected }), signal }), 50000, request.signal);
      if (current.current === captured && active.current === request) setMessage(MESSAGES[reply.code] ?? "The desktop request did not complete. Inspect OBS before trying again.");
    } catch {
      if (current.current === captured && active.current === request) setMessage("No confirmation received. Inspect OBS before trying again; the request is not retried automatically.");
    } finally {
      if (active.current === request) { active.current = null; setBusy(null); }
    }
  };
  return { devices: eligible, deviceId, setDeviceId, busy: owner ? busy : null, message: owner ? message : "", reason, add, retry: () => void availability.mutate() };
}
