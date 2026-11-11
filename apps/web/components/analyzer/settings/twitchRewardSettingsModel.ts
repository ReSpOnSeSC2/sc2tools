"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";

export const REWARD_ACTIONS = {
  randomizer: "Reroll randomizer for next game", buildVote: "Start a build vote", pin: "Pin the viewer's message",
  recap: "Show the session recap", broll: "Play the next b-roll clip", tts: "Read the viewer's input aloud",
} as const;
export const SETTLEMENT_OPTIONS = { none: "Manual on Twitch", fulfill: "Fulfill when applied", refund: "Refund if unavailable", both: "Fulfill or refund automatically" } as const;
export type RewardMapping = { rewardId: string; action: keyof typeof REWARD_ACTIONS; enabled: boolean; cooldownSec: number; settlement: keyof typeof SETTLEMENT_OPTIONS; buildIds: string[] };
export type RewardSettings = { enabled: boolean; target: string | null; mappings: RewardMapping[] };
export type Reward = { id: string; title: string; enabled: boolean; manageable: boolean; autoSkipsQueue: boolean };
export type RewardActivity = { rewardId: string; rewardTitle?: string; action: keyof typeof REWARD_ACTIONS; receivedAt: string; state: string; reason?: string; settlement?: string };
type Status = { settings: RewardSettings; permission: boolean; available: boolean; targets: { id: string; label: string }[]; builds: { id: string; name: string }[]; activity: RewardActivity[] };
const ROOT = "/v1/me/twitch-rewards";

export function useTwitchRewardSettings(owner: string) {
  const { getToken, userId } = useAuth();
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const ownerRef = useRef(userId); ownerRef.current = userId;
  const requestRef = useRef<AbortController | null>(null);
  const popupRef = useRef<Window | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [catalog, setCatalog] = useState<Reward[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const run = useCallback(async <T,>(work: (request: <V>(path: string, init?: RequestInit) => Promise<V>) => Promise<T>, apply: (value: T) => void) => {
    if (requestRef.current || ownerRef.current !== owner) return false;
    const controller = new AbortController(); requestRef.current = controller;
    const current = () => requestRef.current === controller && !controller.signal.aborted && ownerRef.current === owner;
    setBusy(true); setError(""); setMessage("");
    const request = <V,>(path: string, init: RequestInit = {}) => boundedApiRequest(async signal => {
      const token = await tokenRef.current();
      if (!current() || signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!token) throw new Error("Sign in again to continue.");
      const res = await fetch(`${API_BASE}${path}`, { ...init, cache: "no-store", signal, headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
      if (!res.ok) throw await buildApiError(res);
      return await res.json() as V;
    }, 20_000, controller.signal);
    try {
      const result = await work(request);
      if (!current()) return false;
      apply(result);
      return true;
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : "Twitch reward settings are unavailable.");
      return false;
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  }, [owner]);

  const refresh = useCallback(() => run(async request => request<Status>(ROOT), setStatus), [run]);
  useEffect(() => {
    void refresh();
    return () => { requestRef.current?.abort(); requestRef.current = null; popupRef.current?.close(); popupRef.current = null; };
  }, [refresh]);

  const loadCatalog = () => run(request => request<{ rewards: Reward[] }>(`${ROOT}/catalog`), value => setCatalog(value.rewards));
  const save = (draft: RewardSettings) => run(request => request<RewardSettings>(ROOT, { method: "PUT", body: JSON.stringify(draft) }), value => {
    setStatus(previous => previous ? { ...previous, settings: value } : previous);
    setMessage("Twitch reward settings saved.");
  });
  const create = (title: string, cost: number, requiresInput: boolean) => run(request => request<{ reward: Reward }>(`${ROOT}/catalog`, {
    method: "POST", body: JSON.stringify({ title, cost, requiresInput }),
  }), ({ reward }) => {
    setCatalog(previous => [reward, ...previous.filter(value => value.id !== reward.id)]);
    setMessage("Reward created. Enable it on Twitch when you’re ready.");
  });
  const connect = async () => {
    if (requestRef.current) return;
    popupRef.current?.close();
    const popup = window.open("", "sc2tools-twitch-rewards", "popup,width=620,height=760");
    if (!popup) { setError("Allow popups for SC2Tools, then try again."); return; }
    popupRef.current = popup;
    const ok = await run(async request => {
      const value = await request<{ authorizeUrl: string }>("/v1/me/integrations/twitch/connect", { method: "POST", body: JSON.stringify({ purpose: "rewards" }) });
      const url = new URL(value.authorizeUrl);
      if (url.origin !== "https://id.twitch.tv" || url.pathname !== "/oauth2/authorize" || url.username || url.password) throw new Error("The Twitch connection address was invalid.");
      return url.href;
    }, href => {
      popup.location.replace(href);
      setMessage("Complete the Twitch connection, then refresh permission here.");
    });
    if (!ok) { popup.close(); if (popupRef.current === popup) popupRef.current = null; }
  };
  return { status, catalog, busy, error, message, refresh, loadCatalog, save, create, connect };
}
