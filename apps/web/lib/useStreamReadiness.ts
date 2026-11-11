"use client";

import { useEffect, useState } from "react";
import { useApi, type ApiResponse } from "./clientApi";
import { normalizePresence, type OverlayPresence } from "./overlayPresence";
import { streamReadiness, type PairedStreamDevice, type ReadinessId, type ReadinessResource, type StreamToken } from "./streamReadiness";
import type { MultichatConfig } from "./multichat/types";

const POLL = { refreshInterval: 30_000, dedupingInterval: 5000, refreshWhenHidden: false, refreshWhenOffline: false, shouldRetryOnError: false, keepPreviousData: false };
const REQUEST = { timeoutMs: 10_000 };
const LOADING = { loading: true } as const;
const ERROR = { error: true } as const;

type SelectedSource = {
  token: StreamToken;
  snapshot: OverlayPresence | null;
  failed: boolean;
  refresh: () => void;
};

function useVisibleTab() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const check = () => setVisible(!document.hidden);
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  return visible;
}

function resource<T, R>(result: ApiResponse<T>, convert: (data: T) => R | undefined): ReadinessResource<R> {
  if (result.error) return ERROR;
  if (result.data === undefined) return LOADING;
  const data = convert(result.data);
  return data === undefined ? ERROR : { data };
}

function firstActiveToken(data: { items: StreamToken[] }): StreamToken | null | undefined {
  if (!Array.isArray(data?.items)) return undefined;
  return data.items.find((token) => token && typeof token.token === "string" && token.token && !token.revokedAt && !token.rotationPending) ?? null;
}

function currentPresence(snapshot: OverlayPresence | null) {
  return snapshot && Date.now() - Date.parse(snapshot.sampledAt) <= 45_000;
}

export function useStreamReadiness(enabled: boolean, selected?: SelectedSource) {
  const visible = useVisibleTab();
  const active = enabled && visible;
  const devices = useApi<{ items: PairedStreamDevice[] }>(active ? "/v1/devices" : null, POLL, REQUEST);
  const multichat = useApi<MultichatConfig>(active ? "/v1/me/preferences/multichat" : null, POLL, REQUEST);
  const tokenList = useApi<{ items: StreamToken[] }>(active && !selected ? "/v1/overlay-tokens" : null, POLL, REQUEST);
  const tokens = selected ? { data: selected.token } : resource(tokenList, firstActiveToken);
  const token = "data" in tokens ? tokens.data : null;
  const sourcePath = active && token && !selected ? `/v1/overlay-tokens/${encodeURIComponent(token.token)}/presence` : null;
  const status = useApi<unknown>(sourcePath, POLL, REQUEST);
  const presence: ReadinessResource<OverlayPresence | null> = selected ? (selected.failed ? ERROR : selected.snapshot ? { data: selected.snapshot } : LOADING)
    : "data" in tokens ? token ? resource(status, (data) => normalizePresence(data) ?? undefined) : { data: null }
      : tokens;
  const checks = streamReadiness({
    devices: resource(devices, (data) => Array.isArray(data?.items) ? data.items : undefined),
    tokens,
    presence: "data" in presence && presence.data && !currentPresence(presence.data) ? LOADING : presence,
    multichat: resource(multichat, (data) => data && typeof data === "object" && !Array.isArray(data) ? data : undefined),
  }, Date.now());

  function retry(id: ReadinessId) {
    if (!active) return;
    if (id === "device") void devices.mutate();
    else if (id === "chat") void multichat.mutate();
    else if (selected) selected.refresh();
    else if (sourcePath) void status.mutate();
    else void tokenList.mutate();
  }

  const starterWidgets = "error" in tokens ? { state: "error" } as const
    : "data" in tokens ? { state: "ready", enabled: token?.enabledWidgets ?? [] } as const : { state: "loading" } as const;
  return { checks, retry, starterWidgets };
}

export type StarterWidgetStatus = ReturnType<typeof useStreamReadiness>["starterWidgets"];
