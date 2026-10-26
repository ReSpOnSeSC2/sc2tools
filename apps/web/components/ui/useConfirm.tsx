"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";

export type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "onClose" | "onConfirm" | "loading">;
type Request = { id: number; options: ConfirmOptions; resolve: (accepted: boolean) => void };
type Scope = { key: unknown; active: boolean; request: Request | null };

/** A local, controlled confirmation outlet. Mutations stay with the caller.
 * Render `dialog` once; pass a record/account key to cancel pending decisions
 * when its context changes. Existing typed destructive flows remain separate.
 */
export function useConfirm(scopeKey?: unknown) {
  const scopeRef = useRef<Scope>({ key: scopeKey, active: false, request: null });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current.active = false;
    scopeRef.current = { key: scopeKey, active: false, request: null };
  }
  const scope = scopeRef.current;
  const counter = useRef(0);
  const [pending, setPending] = useState<{ scope: Scope; request: Request } | null>(null);

  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      const request = scope.request;
      scope.request = null;
      request?.resolve(false);
    };
  }, [scope]);

  const finish = useCallback((request: Request, requestScope: Scope, accepted: boolean) => {
    if (!requestScope.active || scopeRef.current !== requestScope || requestScope.request !== request) return;
    requestScope.request = null;
    setPending(current => current?.request === request ? null : current);
    request.resolve(accepted);
  }, []);
  const cancel = useCallback(() => {
    if (scopeRef.current === scope && scope.request) finish(scope.request, scope, false);
  }, [finish, scope]);
  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // Repeated activations do not replace an unanswered prompt or hang a
    // second promise. The caller may explicitly cancel before asking again.
    if (scopeRef.current !== scope || !scope.active || scope.request) return Promise.resolve(false);
    return new Promise(resolve => {
      const request = { id: ++counter.current, options, resolve };
      scope.request = request;
      setPending({ scope, request });
    });
  }, [scope]);
  const visible = pending?.scope === scope && scope.active && scope.request === pending.request ? pending.request : null;
  const dialog = visible ? <ConfirmDialog key={visible.id} {...visible.options} open
    onClose={() => finish(visible, scope, false)} onConfirm={() => finish(visible, scope, true)} /> : null;
  return { confirm, cancel, dialog };
}
