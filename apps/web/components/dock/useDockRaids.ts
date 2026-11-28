"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { RAID_WINDOW_MS, raidResultMessage, readRaidResult, readRaidView, type RaidView } from "@/lib/twitchRaids";

export type RaidBusy = "refresh" | "start" | "cancel";
type RaidAction = { action: "start"; streamId: string } | { action: "cancel" };
const TIMEOUT_MS = 20_000;

/**
 * The raid finder's data for one Stream Dock: the ranked list, and Start and
 * Cancel. One request runs at a time; whatever Twitch answers is kept in
 * `notice` or `error` so the panel can show it in place. Twitch is asked once
 * per click: a failed or unclear start is shown, never retried.
 */
export function useDockRaids(token: string) {
  const [view, setView] = useState<RaidView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<RaidBusy | null>("refresh");
  const running = useRef<AbortController | null>(null);
  const closed = useRef(false);
  const url = `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/raids`;

  const send = useCallback(async (kind: RaidBusy, action?: RaidAction, keepError = false): Promise<boolean> => {
    if (running.current) return false;
    const controller = new AbortController();
    running.current = controller;
    setBusy(kind);
    if (!keepError) setError("");
    if (kind !== "refresh") setNotice("");
    try {
      const body = await boundedApiRequest(async signal => {
        const init: RequestInit = action
          ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action, confirmed: true }) }
          : {};
        const response = await fetch(url, { ...init, signal, cache: "no-store" });
        if (!response.ok) throw await buildApiError(response);
        return response.json() as Promise<unknown>;
      }, TIMEOUT_MS, controller.signal);
      const next = readRaidView(body);
      if (controller.signal.aborted) return false;
      if (!next) throw new Error("Twitch raid data was not in the expected shape. Refresh and try again.");
      setView(next);
      const result = readRaidResult(body);
      if (result) setNotice(raidResultMessage(result));
      return true;
    } catch (failure) {
      if (controller.signal.aborted) return false;
      setError((failure as { message?: string }).message || "Raids are unavailable right now. Try again.");
      return false;
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy(null);
      }
    }
  }, [url]);

  const refresh = useCallback(() => send("refresh"), [send]);
  // A refused or unclear action still wrote a history row, so the list is
  // read again while the answer stays on screen.
  const act = useCallback(async (kind: "start" | "cancel", action: RaidAction) => {
    const done = await send(kind, action);
    if (!done && !closed.current) await send("refresh", undefined, true);
    return done;
  }, [send]);
  const start = useCallback((streamId: string) => act("start", { action: "start", streamId }), [act]);
  const cancel = useCallback(() => act("cancel", { action: "cancel" }), [act]);

  useEffect(() => {
    closed.current = false;
    void refresh();
    return () => { closed.current = true; running.current?.abort(); running.current = null; };
  }, [refresh]);

  // A queued raid stops being cancellable once Twitch's countdown is over.
  const pendingAt = view?.pending?.at;
  useEffect(() => {
    if (!pendingAt) return;
    const timer = setTimeout(() => { void refresh(); }, Math.max(1000, pendingAt + RAID_WINDOW_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingAt, refresh]);

  return { view, error, notice, busy, refresh, start, cancel };
}
