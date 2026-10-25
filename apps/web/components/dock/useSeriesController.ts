"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, boundedApiRequest } from "@/lib/clientApi";
import { responseWasReplaced } from "@/components/overlay/overlayLinkStatus";
import { newerSeries, normalizeSeriesSnapshot, type SeriesSnapshot } from "@/lib/streamSeries";

/** One finite bootstrap plus explicit refresh and socket updates. There is no
 * polling. Revisions fence held GET/POST results; token epochs fence ABA. */
export function useSeriesController(token: string, rawEvent: unknown, onInvalid: (replaced?: boolean) => void) {
  const scope = useRef({ token }); if (scope.current.token !== token) scope.current = { token };
  const identity = scope.current, invalid = useRef(onInvalid); invalid.current = onInvalid;
  const reads = useRef<AbortController | null>(null), writes = useRef<AbortController | null>(null);
  const received = useRef(0);
  const latest = useRef<{ identity: typeof identity; series: SeriesSnapshot | null }>({ identity, series: null });
  if (latest.current.identity !== identity) latest.current = { identity, series: null };
  const [state, setState] = useState<{ identity: typeof identity; series: SeriesSnapshot | null; ready: boolean; busy: boolean; error: string }>({ identity, series: null, ready: false, busy: false, error: "" });
  const receive = useCallback((raw: unknown) => {
    if (scope.current !== identity) return false;
    const clean = normalizeSeriesSnapshot(raw); if (clean === undefined) return false;
    received.current++;
    const series = newerSeries(latest.current.series, clean); latest.current = { identity, series };
    setState(current => ({ ...(current.identity === identity ? current : { identity, busy: false }), series, ready: true, error: "" })); return true;
  }, [identity]);
  const request = async (controller: AbortController, body?: Record<string, unknown>) => boundedApiRequest(async signal => {
    const current = () => scope.current === identity && !signal.aborted;
    const response = await fetch(`${API_BASE}/v1/multichat/${encodeURIComponent(token)}/series`, { method: body ? "POST" : "GET", cache: "no-store", signal,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!current()) throw new DOMException("Series token changed", "AbortError");
    if (response.status === 401) {
      const replaced = await responseWasReplaced(response); if (current()) invalid.current(replaced);
      throw new Error("This Dock link no longer works. Copy its current URL from Settings.");
    }
    if (!response.ok) throw new Error(response.status === 409 ? "Series changed elsewhere. Refresh before trying again." : "Couldn't confirm Series. Refresh the score before trying again.");
    const raw = await response.json(); signal.throwIfAborted();
    if (!current()) throw new DOMException("Series token changed", "AbortError");
    if (normalizeSeriesSnapshot(raw) === undefined) throw new Error("Couldn't read the Series response. Refresh before trying again.");
    return raw;
  }, 20_000, controller.signal);
  const requestRef = useRef(request); requestRef.current = request;
  const refresh = useCallback(async () => {
    reads.current?.abort(); const controller = new AbortController(), before = received.current; reads.current = controller;
    try { const raw = await requestRef.current(controller); if (scope.current === identity && reads.current === controller && !controller.signal.aborted) receive(raw); }
    catch (error) { if (scope.current === identity && reads.current === controller && !controller.signal.aborted && received.current === before) setState(current => ({ ...current, identity, ready: false, error: error instanceof Error ? error.message : "Couldn't read Series. Try again." })); }
    finally { if (reads.current === controller) reads.current = null; }
  }, [identity, receive]);
  useEffect(() => {
    void refresh();
    return () => { const read = reads.current, write = writes.current; reads.current = null; writes.current = null; read?.abort(); write?.abort(); };
  }, [identity, refresh]);
  useEffect(() => { if (rawEvent !== undefined) receive(rawEvent); }, [rawEvent, receive]);
  const act = async (body: Record<string, unknown>) => {
    if (scope.current !== identity || writes.current || state.identity !== identity || !state.ready) return false;
    const controller = new AbortController(); writes.current = controller;
    setState(current => ({ ...current, busy: true, error: "" }));
    try {
      const raw = await requestRef.current(controller, { ...body, revision: latest.current.series?.revision ?? 0 });
      if (scope.current !== identity || writes.current !== controller || controller.signal.aborted) return false;
      return receive(raw);
    } catch (error) {
      if (scope.current === identity && writes.current === controller && !controller.signal.aborted) setState(current => ({ ...current, ready: false, error: error instanceof Error ? error.message : "Couldn't confirm Series. Refresh before trying again." }));
      return false;
    } finally { if (writes.current === controller) { writes.current = null; setState(current => current.identity === identity ? { ...current, busy: false } : current); } }
  };
  return { series: state.identity === identity ? state.series : null, ready: state.identity === identity && state.ready,
    busy: state.identity === identity && state.busy, error: state.identity === identity ? state.error : "", refresh, act };
}
