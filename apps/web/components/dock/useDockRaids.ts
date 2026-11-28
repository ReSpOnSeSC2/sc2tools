"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { RAID_WINDOW_MS, raidResultMessage, readRaidResult, readRaidView, type RaidView } from "@/lib/twitchRaids";

export type RaidBusy = "refresh" | "start" | "cancel";
type RaidAction = { action: "start"; streamId: string } | { action: "cancel" };
type Failure = { message: string; code: string };
const TIMEOUT_MS = 20_000;
/** While Twitch has not answered, the list is read again this often. */
const WAITING_POLL_MS = 5000;
const NO_FAILURE: Failure = { message: "", code: "" };

async function requestRaids(url: string, action: RaidAction | undefined, signal: AbortSignal): Promise<unknown> {
  const init: RequestInit = action
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action, confirmed: true }) }
    : {};
  const response = await fetch(url, { ...init, signal, cache: "no-store" });
  if (!response.ok) throw await buildApiError(response);
  return response.json();
}

function readAnswer(body: unknown): { view: RaidView; notice: string } {
  const view = readRaidView(body);
  if (!view) throw new Error("Twitch raid data was not in the expected shape. Refresh and try again.");
  const result = readRaidResult(body);
  return { view, notice: result ? raidResultMessage(result) : "" };
}

function toFailure(error: unknown): Failure {
  const { message, code } = error as { message?: string; code?: string };
  return { message: message || "Raids are unavailable right now. Try again.", code: code ?? "" };
}

/**
 * The raid finder's data for one Stream Dock: the ranked list, and Start and
 * Cancel. One request runs at a time; whatever Twitch answers is kept in
 * `notice` or `error` so the panel can show it in place. Twitch is asked once
 * per click: a failed or unclear start is shown, never retried.
 */
export function useDockRaids(token: string) {
  const [view, setView] = useState<RaidView | null>(null);
  const [failure, setFailure] = useState(NO_FAILURE);
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
    if (!keepError) setFailure(NO_FAILURE);
    if (kind !== "refresh") setNotice("");
    try {
      const body = await boundedApiRequest(signal => requestRaids(url, action, signal), TIMEOUT_MS, controller.signal);
      if (controller.signal.aborted) return false;
      const answer = readAnswer(body);
      setView(answer.view);
      if (answer.notice) setNotice(answer.notice);
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setFailure(toFailure(error));
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

  // A raid that may be live is read again: soon while Twitch has not answered,
  // and when Twitch's countdown is over, so Cancel raid goes with it.
  const pending = view?.pending ?? null;
  useEffect(() => {
    if (!pending) return;
    const wait = pending.state === "pending" ? WAITING_POLL_MS : Math.max(1000, pending.at + RAID_WINDOW_MS - Date.now());
    const timer = setTimeout(() => { void refresh(); }, wait);
    return () => clearTimeout(timer);
  }, [pending, refresh]);

  // Twitch itself says a raid is queued that this Dock has no record of
  // (started in Twitch chat, say), so Cancel raid is offered for it.
  const queuedElsewhere = failure.code === "raid_already_queued";
  return { view, error: failure.message, queuedElsewhere, notice, busy, refresh, start, cancel };
}
