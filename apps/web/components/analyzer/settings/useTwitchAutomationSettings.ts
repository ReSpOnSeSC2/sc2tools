"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { twitchPreferences, twitchStatus, type TwitchAutomationPreferences, type TwitchAutomationStatus } from "@/lib/twitchAutomation";

type Scope = { owner: string; active: boolean; controller: AbortController | null; popup: Window | null };
type State = { scope: Scope; status: TwitchAutomationStatus | null; busy: boolean; error: string; message: string };
export function useTwitchAutomationSettings() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const scopeRef = useRef<Scope | null>(null);
  const [state, setState] = useState<State | null>(null);
  const current = (scope: Scope, controller: AbortController) => scope.active && scopeRef.current === scope && ownerRef.current === scope.owner && scope.controller === controller && !controller.signal.aborted;
  const request = useCallback(async (scope: Scope, path: string, init: RequestInit = {}) => {
    scope.controller?.abort(); const controller = new AbortController(); scope.controller = controller;
    setState(previous => ({ scope, status: previous?.scope === scope ? previous.status : null, busy: true, error: "", message: "" }));
    let result: unknown;
    try { result = await boundedApiRequest(async signal => {
      if (!current(scope, controller)) throw new DOMException("Cancelled", "AbortError");
      const token = await tokenRef.current();
      if (!current(scope, controller) || signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!token) throw new Error("Sign in again before changing Twitch settings.");
      const response = await fetch(`${API_BASE}${path}`, { ...init, signal, cache: "no-store", headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` } });
      if (!response.ok) throw await buildApiError(response);
      const body: unknown = await response.json();
      if (!current(scope, controller) || signal.aborted) throw new DOMException("Cancelled", "AbortError");
      return body;
    }, 20_000, controller.signal); }
    catch (error) {
      if (!current(scope, controller)) throw Object.assign(new Error("Cancelled"), { staleOperation: true });
      throw error;
    }
    return { result, controller };
  }, []);
  const failure = (scope: Scope, error: unknown) => {
    if ((error as { staleOperation?: boolean })?.staleOperation) return;
    if (scopeRef.current === scope && scope.active && ownerRef.current === scope.owner) setState(previous => ({ scope, status: previous?.scope === scope ? previous.status : null, busy: false, error: (error as { message?: string })?.message || "Twitch status is unavailable. Try again.", message: "" }));
  };
  const refresh = useCallback(async () => {
    const scope = scopeRef.current; if (!scope?.active || ownerRef.current !== scope.owner) return;
    try { const { result, controller } = await request(scope, "/v1/me/twitch-automation"); if (current(scope, controller)) setState({ scope, status: twitchStatus(result), busy: false, error: "", message: "" }); }
    catch (error) { failure(scope, error); }
  }, [request]);
  useLayoutEffect(() => {
    if (!owner) { scopeRef.current = null; setState(null); return; }
    const scope: Scope = { owner, active: true, controller: null, popup: null }; scopeRef.current = scope;
    void refresh();
    return () => { scope.active = false; scope.controller?.abort(); const popup = scope.popup; scope.popup = null; popup?.close(); };
  }, [owner, refresh]);
  const save = async (preferences: TwitchAutomationPreferences) => {
    const scope = scopeRef.current; if (!scope?.active || ownerRef.current !== scope.owner || state?.busy || !state?.status) return;
    try {
      const { result, controller } = await request(scope, "/v1/me/preferences/twitchAutomation", { method: "PUT", body: JSON.stringify(preferences) });
      if (current(scope, controller)) setState(previous => ({ scope, status: previous?.status ? { ...previous.status, preferences: twitchPreferences(result) } : null, busy: false, error: "", message: "Twitch automation preferences saved." }));
    } catch (error) { failure(scope, error); }
  };
  const connect = async (purpose: "predictions" | "streaming") => {
    const scope = scopeRef.current; if (!scope?.active || ownerRef.current !== scope.owner || state?.busy || !state?.status?.serverEnabled) return;
    // A named popup may be reused by window.open. Close our previous flow
    // before opening, otherwise closing it afterward can close the new flow.
    scope.popup?.close(); scope.popup = null;
    const popup = window.open("", "sc2tools-twitch-automation", "popup,width=620,height=760");
    if (!popup) { failure(scope, new Error("Allow popups for SC2Tools, then try again.")); return; }
    scope.popup = popup;
    const closePopup = () => { if (scope.popup === popup) { scope.popup = null; popup.close(); } };
    try {
      const { result, controller } = await request(scope, "/v1/me/integrations/twitch/connect", { method: "POST", body: JSON.stringify({ purpose }) });
      if (!current(scope, controller)) { closePopup(); return; }
      const url = new URL(String((result as { authorizeUrl?: unknown })?.authorizeUrl));
      if (url.origin !== "https://id.twitch.tv" || url.pathname !== "/oauth2/authorize" || url.username || url.password) throw new Error("The Twitch connection address was invalid.");
      popup.location.replace(url.href);
      setState(previous => ({ scope, status: previous?.status || null, busy: false, error: "", message: "Complete the Twitch connection in its window, then Refresh status. Your toggles remain unchanged." }));
    } catch (error) { closePopup(); failure(scope, error); }
  };
  const visible = owner && state?.scope === scopeRef.current && state.scope.owner === owner ? state : null;
  return { owner, status: visible?.status || null, busy: visible?.busy || false, error: visible?.error || "", message: visible?.message || "", refresh, save, connect };
}
