"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest, useApi, type ClientApiError } from "@/lib/clientApi";
import { readChatCommands, serializeChatCommands, validateChatCommands, type ChatCommandPreferences, type CommandReply } from "./chatCommandPreferences";
const PATH = "/v1/me/preferences/chatCommands";
type State = { scope: string; saved: ChatCommandPreferences | null; draft: ChatCommandPreferences | null; busy: string; error: string; preview: (CommandReply & { trigger: string }) | null };
const empty = (scope: string): State => ({ scope, saved: null, draft: null, busy: "", error: "", preview: null });

/** Private preference reads and explicit saves/previews share one scoped deadline.
 * Token resolution, bodies and late cache acknowledgements cannot cross owners. */
export function useChatCommandSettings(token: string) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null, scope = JSON.stringify([owner, token]);
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(false), active = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>(() => empty(scope));
  const request = useApi<ChatCommandPreferences>(owner && token ? PATH : null, { revalidateOnFocus: false }, { timeoutMs: 20_000 });
  useLayoutEffect(() => { mounted.current = true; setState(empty(scope)); return () => { mounted.current = false; active.current?.abort(); active.current = null; }; }, [scope]);
  useEffect(() => {
    if (!owner || !token || !request.data || request.isPreviousData || request.error) return;
    const value = readChatCommands(request.data);
    setState(previous => previous.scope === scope && previous.saved ? previous : { ...empty(scope), saved: value, draft: value });
  }, [owner, token, scope, request.data, request.isPreviousData, request.error]);
  const view = state.scope === scope ? state : empty(scope);
  const ready = !!owner && !!token && !!view.draft && !request.isPreviousData && !request.error;
  const dirty = !!view.draft && JSON.stringify(view.draft) !== JSON.stringify(view.saved);
  const run = async (kind: string, operation: (context: { signal: AbortSignal; safeToken: () => Promise<string | null>; valid: () => boolean }) => Promise<void>) => {
    if (!ready || active.current) return false;
    const controller = new AbortController(), captured = scope; active.current = controller;
    const valid = () => mounted.current && current.current === captured && active.current === controller && !controller.signal.aborted;
    setState(previous => ({ ...previous, busy: kind, error: "", preview: null }));
    try {
      await boundedApiRequest(signal => operation({ signal, valid, safeToken: async () => {
        const jwt = await getToken(); if (!valid()) throw new DOMException("Account changed", "AbortError"); signal.throwIfAborted(); return jwt;
      } }), 20_000, controller.signal);
      return valid();
    } catch (error) {
      if (valid()) setState(previous => ({ ...previous, error: (error as ClientApiError)?.status === 400 ? (error as ClientApiError).message : "Couldn’t finish this command request. Your draft is kept; try again." }));
      return false;
    } finally {
      if (active.current === controller) { active.current = null; if (mounted.current && current.current === captured) setState(previous => ({ ...previous, busy: "" })); }
    }
  };
  const save = async () => {
    if (!view.draft || !dirty) return false;
    const error = validateChatCommands(view.draft);
    if (error) { setState(previous => ({ ...previous, error })); return false; }
    const payload = serializeChatCommands(view.draft);
    return run("save", async ({ signal, safeToken, valid }) => {
      const response = await apiCall<ChatCommandPreferences>(safeToken, PATH, { method: "PUT", signal, body: JSON.stringify(payload) });
      if (!valid()) return;
      const saved = readChatCommands(response); await request.mutate(response, false);
      if (valid()) setState({ ...empty(scope), saved, draft: saved, busy: "save" });
    });
  };
  const tryCommand = async (trigger: string, argument: string, user: string, platform: string, onStream: boolean) => {
    if (dirty) return false;
    return run(trigger, async ({ signal, safeToken, valid }) => {
      const response = await apiCall<CommandReply>(safeToken, "/v1/me/chat-commands/try", { method: "POST", signal, body: JSON.stringify({ token, command: trigger, argument, user, platform, onStream }) });
      if (valid()) setState(previous => ({ ...previous, preview: { ...response, trigger } }));
    });
  };
  return { ...view, ready, dirty, readError: request.error, loading: !request.error && !ready,
    setDraft: (draft: ChatCommandPreferences) => { if (ready && !active.current) setState(previous => ({ ...previous, draft, error: "", preview: null })); },
    save, tryCommand, retry: () => { void request.mutate().catch(() => {}); } };
}
