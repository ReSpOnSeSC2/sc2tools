"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { readRaidSettings, type RaidSettingsView } from "@/lib/twitchRaids";

const ROOT = "/v1/me/twitch-raids";
const TIMEOUT_MS = 20_000;

/**
 * The streamer's raid settings: Twitch permission state, the server gate and
 * the switch. The switch saves at once and shows the saved answer. Raids have
 * their own Twitch connect, which opens in a popup and leaves the switch alone.
 */
export function useTwitchRaidSettings(owner: string) {
  const { getToken, userId } = useAuth();
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const ownerRef = useRef(userId); ownerRef.current = userId;
  const running = useRef<AbortController | null>(null);
  const popup = useRef<Window | null>(null);
  const [status, setStatus] = useState<RaidSettingsView | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const run = useCallback(async <T,>(work: (request: <V>(path: string, init?: RequestInit) => Promise<V>) => Promise<T>, apply: (value: T) => void) => {
    if (running.current || ownerRef.current !== owner) return false;
    const controller = new AbortController();
    running.current = controller;
    const current = () => running.current === controller && !controller.signal.aborted && ownerRef.current === owner;
    setBusy(true); setError(""); setMessage("");
    const request = <V,>(path: string, init: RequestInit = {}) => boundedApiRequest(async signal => {
      const token = await tokenRef.current();
      if (!current() || signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!token) throw new Error("Sign in again to continue.");
      const response = await fetch(`${API_BASE}${path}`, { ...init, cache: "no-store", signal, headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
      if (!response.ok) throw await buildApiError(response);
      return await response.json() as V;
    }, TIMEOUT_MS, controller.signal);
    try {
      const result = await work(request);
      if (!current()) return false;
      apply(result);
      return true;
    } catch (failure) {
      if (current()) setError((failure as { message?: string })?.message || "Raid settings are unavailable.");
      return false;
    } finally {
      if (running.current === controller) { running.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  }, [owner]);

  const read = useCallback((body: unknown) => {
    const next = readRaidSettings(body);
    if (!next) throw new Error("Raid settings were not in the expected shape.");
    return next;
  }, []);
  const refresh = useCallback(() => run(async request => read(await request<unknown>(ROOT)), setStatus), [run, read]);
  useEffect(() => {
    void refresh();
    return () => { running.current?.abort(); running.current = null; popup.current?.close(); popup.current = null; };
  }, [refresh]);

  const setEnabled = (enabled: boolean) => run(async request => read(await request<unknown>(ROOT, { method: "PUT", body: JSON.stringify({ enabled }) })), next => {
    setStatus(next);
    setMessage(next.enabled ? "Raids are on. Start one from the Stream Dock when you pick Stream ending." : "Raids are off.");
  });

  const connect = async () => {
    if (running.current) return;
    popup.current?.close();
    const opened = window.open("", "sc2tools-twitch-raids", "popup,width=620,height=760");
    if (!opened) { setError("Allow popups for SC2Tools, then try again."); return; }
    popup.current = opened;
    const ok = await run(async request => {
      const value = await request<{ authorizeUrl: string }>("/v1/me/integrations/twitch/connect", { method: "POST", body: JSON.stringify({ purpose: "raids" }) });
      const url = new URL(value.authorizeUrl);
      if (url.origin !== "https://id.twitch.tv" || url.pathname !== "/oauth2/authorize" || url.username || url.password) throw new Error("The Twitch connection address was invalid.");
      return url.href;
    }, href => {
      opened.location.replace(href);
      setMessage("Complete the Twitch connection in its window, then refresh status here.");
    });
    if (!ok) { opened.close(); if (popup.current === opened) popup.current = null; }
  };
  return { status, busy, error, message, refresh, setEnabled, connect };
}
