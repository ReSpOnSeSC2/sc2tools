"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { mergeClipMoments } from "@/lib/multichat/clipLog";
import { sanitizeClipMoments, type ClipMoment } from "@/lib/multichat/useEngagementState";

const PAGE_SIZE = 100;
type Cursor = { atMs: number; id?: string };
const EMPTY_PAGE = { token: "", items: [] as ClipMoment[], next: null as Cursor | null, loading: false, error: "", pages: 1 };

export function useDockClipLog(token: string, enabled: boolean, live: ReadonlyArray<ClipMoment>) {
  const [page, setPage] = useState(EMPTY_PAGE);
  const active = page.token === token ? page : EMPTY_PAGE;
  const pending = useRef<AbortController | null>(null);
  const listPath = `${API_BASE}/v1/multichat/${encodeURIComponent(token)}`;
  const [flagging, setFlagging] = useState(false);
  const [flagError, setFlagError] = useState("");
  const flagRequest = useRef<AbortController | null>(null);

  const load = useCallback(async (before?: Cursor) => {
    if (!enabled || !token || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setPage((current) => ({ ...(current.token === token ? current : EMPTY_PAGE), token, loading: true, error: "" }));
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) query.set("before", String(before.atMs));
      if (before?.id) query.set("beforeId", before.id);
      const response = await fetch(`${listPath}/moments?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("load_failed");
      const { moments, hasMore, next } = await response.json() as { moments?: unknown; hasMore?: unknown; next?: Cursor };
      if (controller.signal.aborted) return;
      const incoming = sanitizeClipMoments(moments, PAGE_SIZE);
      const last = incoming.at(-1);
      const nextPage = hasMore === true && last ? (next ?? { atMs: last.atMs }) : null;
      setPage((current) => current.token === token ? {
        token, items: mergeClipMoments(current.items, incoming), next: before || current.pages === 1 ? nextPage : current.next,
        loading: false, error: "", pages: current.pages + (before ? 1 : 0),
      } : current);
    } catch {
      if (!controller.signal.aborted) setPage((current) => current.token === token ? {
        ...current, loading: false, error: "Couldn’t load clip moments.",
      } : current);
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [enabled, listPath, token]);

  useEffect(() => {
    setFlagging(false);
    setFlagError("");
    void load();
    return () => {
      pending.current?.abort();
      pending.current = null;
      flagRequest.current?.abort();
      flagRequest.current = null;
    };
  }, [load]);

  async function flag(note: string) {
    if (!enabled || !token || flagRequest.current) return false;
    const controller = new AbortController();
    flagRequest.current = controller;
    setFlagging(true);
    setFlagError("");
    try {
      const response = await fetch(`${listPath}/moment`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
        cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      if (response.status === 429) { setFlagError("Too soon. Wait five seconds between flags."); return false; }
      if (!response.ok) throw new Error("flag_failed");
      const { moment } = await response.json() as { moment?: unknown };
      if (controller.signal.aborted) return false;
      const next = sanitizeClipMoments([moment], 1);
      setPage((current) => ({ ...(current.token === token ? current : EMPTY_PAGE), token, items: mergeClipMoments(current.token === token ? current.items : [], next) }));
      return next.length > 0;
    } catch {
      if (!controller.signal.aborted) setFlagError("Couldn’t flag this moment. Try again.");
      return false;
    } finally {
      if (flagRequest.current === controller) { flagRequest.current = null; setFlagging(false); }
    }
  }

  const moments = useMemo(() => mergeClipMoments(active.items, live).slice(0, active.pages * PAGE_SIZE), [active.items, active.pages, live]);
  return {
    moments, flag, flagging, flagError, hasMore: active.next !== null, loading: active.loading, error: active.error,
    loadOlder: () => active.next && load(active.next), retry: () => load(),
  };
}
