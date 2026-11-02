"use client";

import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSWRConfig } from "swr";
import { Button, LinkButton } from "@/components/ui/Button";
import { apiCall, useOwnerRequestScope } from "@/lib/clientApi";
import { syncActionFeedback, syncActionKey, type SyncActionFeedback, type SyncActionReply, type SyncHealthAction } from "@/lib/syncHealthActions";

type Scope = { owner: string | null; active: boolean; controller: AbortController | null };
type ActionState = { scope: Scope; key: string; busy: boolean; feedback: SyncActionFeedback | null; saved: Set<string> };
type Actions = { state: ActionState; available: boolean; run: (action: SyncHealthAction) => Promise<void> };
const Context = createContext<Actions | null>(null);

/** One in-flight action for this private card. Retired owner/unmount scopes
 * cannot send a held JWT, refresh another owner's cache or show stale feedback. */
export function SyncHealthActionsProvider({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const { mutate } = useSWRConfig();
  const ref = useRef<Scope>({ owner, active: !!owner, controller: null });
  if (ref.current.owner !== owner) {
    ref.current.active = false;
    ref.current = { owner, active: !!owner, controller: null };
  }
  const scope = ref.current;
  useLayoutEffect(() => {
    scope.active = !!owner;
    return () => { scope.active = false; scope.controller?.abort(); };
  }, [owner, scope]);
  const empty = (): ActionState => ({ scope, key: "", busy: false, feedback: null, saved: new Set() });
  const [request, setRequest] = useState<ActionState>(empty);
  const state = request.scope === scope ? request : empty();

  async function run(action: SyncHealthAction) {
    if (!owner || !scope.active || ref.current !== scope || scope.controller) return;
    const controller = new AbortController(); scope.controller = controller;
    const key = syncActionKey(action), saved = state.saved;
    const current = () => scope.active && ref.current === scope && scope.controller === controller && !controller.signal.aborted;
    setRequest({ scope, key, busy: true, feedback: null, saved });
    try {
      const result = await runOwned(owner, async (token, signal, assertCurrent) => {
        const body = action.kind === "identity" ? { toonHandle: action.toonHandle } : { deviceId: action.deviceId, reason: action.reason };
        const reply = await apiCall<SyncActionReply>(token, `/v1/me/sync-health/${action.kind}`, { method: "POST", body: JSON.stringify(body), signal });
        assertCurrent(); return reply;
      }, 20_000, controller.signal);
      if (!current()) return;
      const feedback = syncActionFeedback(action.kind, result);
      const nextSaved = new Set(saved);
      if (action.kind === "identity" && !feedback.error) nextSaved.add(key);
      setRequest({ scope, key, busy: false, feedback, saved: nextSaved });
      if (!feedback.error) void mutate(cacheKey => Array.isArray(cacheKey) && cacheKey[0] === "authenticated-api" && cacheKey[1] === owner
        && (cacheKey[2] === "/v1/me/profile" || cacheKey[2] === "/v1/me/sync-health")).catch(() => {});
    } catch (error) {
      if (current()) setRequest({ scope, key, busy: false, feedback: syncActionFeedback(action.kind, null, error), saved });
    } finally {
      if (scope.controller === controller) scope.controller = null;
    }
  }
  return <Context.Provider value={{ state, available: !!owner, run }}>{children}</Context.Provider>;
}

export function SyncHealthActionButton({ action, contextLabel }: { action: SyncHealthAction; contextLabel: string }) {
  const actions = useContext(Context);
  const id = useId();
  if (!actions) return null;
  const { state } = actions, key = syncActionKey(action);
  const selected = state.key === key;
  const saved = state.saved.has(key);
  const feedback = selected ? state.feedback : null;
  const label = action.kind === "identity" ? saved ? "Added" : "Add as my account" : "Retry with latest agent";
  return <div className="space-y-1">
    <Button variant="secondary" size="sm" loading={selected && state.busy} disabled={!actions.available || state.busy || saved}
      aria-label={`${label}: ${contextLabel}`} aria-describedby={feedback ? id : undefined} onClick={() => { void actions.run(action); }}>{label}</Button>
    {feedback ? <div id={id} role={feedback.error ? "alert" : "status"} className={`text-caption ${feedback.error ? "text-danger" : "text-text-muted"}`}>
      <p>{feedback.text}</p>
      {feedback.link ? <LinkButton href={feedback.link.href} variant="ghost" size="sm">{feedback.link.text}</LinkButton> : null}
    </div> : null}
  </div>;
}
