"use client";
import { useLayoutEffect, useMemo, useRef } from "react";
import { apiCall, boundedApiRequest } from "@/lib/clientApi";

export const BUILD_EDITOR_REQUEST_MS = 20_000;
const cancelled = () => new DOMException("This editor request is no longer current.", "AbortError");
type Scope = { key: string; active: boolean; controllers: Set<AbortController>; operations: Map<string, EditorOperation> };
export interface EditorOperation {
  current: () => boolean;
  run: <T>(path: string, init?: RequestInit) => Promise<T>;
  cancel: () => void;
  finish: () => void;
}

/** Abort also settles held token/body promises, even if their mock or network
 * adapter ignores the signal. The losing promise retains a rejection handler. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { listener = () => reject(cancelled()); if (signal.aborted) listener(); else signal.addEventListener("abort", listener, { once: true }); });
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener("abort", listener));
}

/** A render-time identity change invalidates old callbacks before effects. Each
 * operation has one deadline covering JWT, headers, body and optional repair. */
export function useBuildEditorRequests({ owner, open, identity, getToken }: {
  owner: string | null; open: boolean; identity: string; getToken: () => Promise<string | null>;
}) {
  const key = JSON.stringify([owner, open, identity]);
  const scopeRef = useRef<Scope>({ key, active: !!owner && open, controllers: new Set(), operations: new Map() });
  if (scopeRef.current.key !== key) {
    scopeRef.current.active = false;
    scopeRef.current = { key, active: !!owner && open, controllers: new Set(), operations: new Map() };
  }
  const scope = scopeRef.current, tokenRef = useRef(getToken); tokenRef.current = getToken;
  useLayoutEffect(() => {
    scope.active = !!owner && open;
    return () => { scope.active = false; for (const controller of scope.controllers) controller.abort(); scope.controllers.clear(); scope.operations.clear(); };
  }, [scope, owner, open]);
  return useMemo(() => ({ scope, ready: !!owner && open,
    begin(name: string): EditorOperation | null {
      if (!scope.active || scopeRef.current !== scope || scope.operations.has(name)) return null;
      const controller = new AbortController(), deadline = Date.now() + BUILD_EDITOR_REQUEST_MS;
      let closed = false;
      const current = () => !closed && scope.active && scopeRef.current === scope && !controller.signal.aborted;
      const assert = (signal?: AbortSignal) => { if (!current() || signal?.aborted) throw cancelled(); };
      const finish = () => { closed = true; scope.controllers.delete(controller); if (scope.operations.get(name) === operation) scope.operations.delete(name); };
      const operation: EditorOperation = { current, finish, cancel: () => { controller.abort(); finish(); },
        async run<T>(path: string, init: RequestInit = {}) {
          assert(); const remaining = deadline - Date.now();
          if (remaining <= 0) throw Object.assign(new Error("The editor request timed out. Refresh the library before retrying a save."), { status: 0, code: "request_timeout" });
          const value = await boundedApiRequest(signal => abortable(apiCall<T>(async () => {
            assert(signal); const token = await tokenRef.current(); assert(signal);
            if (!token) throw new Error("Sign in again before using this editor.");
            return token;
          }, path, { ...init, signal }), signal), remaining, controller.signal);
          assert(); return value;
        },
      };
      scope.controllers.add(controller); scope.operations.set(name, operation); return operation;
    },
  }), [scope, owner, open]);
}
