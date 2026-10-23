"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveGamePayload } from "./types";
import type { SessionSummary } from "./widgets/SessionWidget";
import { payloadTargetsWidget, TEST_DURATION_MS, type WidgetId } from "./widgetLifecycle";

export type TestClear = { scope?: string; widget?: string | null } | undefined;
type Preview = { token: string; live: LiveGamePayload | null; session: SessionSummary | null; expiresAt: number; excluded: string[] };

/** A sample is a temporary render layer. Real payloads, match envelopes,
 * histories and visibility deadlines continue updating underneath it. */
export function useOverlayTestLayer(token: string) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const seen = useRef<string[]>([]);
  const current = preview?.token === token ? preview : null;
  const receiveLive = useCallback((live: LiveGamePayload) => {
    if (live.testNonce !== undefined) {
      const key = `${token}:${live.testWidget || "all"}:${live.testNonce}`;
      if (seen.current.includes(key)) return;
      seen.current = [...seen.current.slice(-31), key];
    }
    const session = live.session ? { ...live.session, isTest: true } as SessionSummary : null;
    setPreview({ token, live, session, expiresAt: Date.now() + TEST_DURATION_MS, excluded: [] });
  }, [token]);
  const receiveSession = useCallback((session: SessionSummary) => {
    setPreview((previous) => {
      if (session.testNonce !== undefined && (previous?.token !== token || previous.live?.testNonce !== session.testNonce)) return previous;
      return previous?.token === token ? { ...previous, session }
        : { token, live: null, session, expiresAt: Date.now() + TEST_DURATION_MS, excluded: [] };
    });
  }, [token]);
  const clear = useCallback((message: TestClear) => {
    // Legacy clear events omitted scope; they have always meant Stop Test.
    // An unknown explicit scope cannot erase either live or sample data.
    if (message?.scope && message.scope !== "test") return;
    setPreview((previous) => !message?.widget ? null : previous?.token === token
      ? { ...previous, excluded: [...previous.excluded, message.widget] } : previous);
  }, [token]);
  const deadline = current?.expiresAt;
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = window.setTimeout(() => setPreview((previous) => previous?.token === token && previous.expiresAt <= Date.now() ? null : previous), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline, token]);
  const targets = (widget: WidgetId) => Boolean(current && !current.excluded.includes(widget)
    && (current.live ? payloadTargetsWidget(current.live, widget) : widget === "session" && current.session));
  return { live: current?.live || null, session: current?.session || null, receiveLive, receiveSession, clear, targets };
}
