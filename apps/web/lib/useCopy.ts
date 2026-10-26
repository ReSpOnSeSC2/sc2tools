"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copying" | "copied" | "fallback";
export interface UseCopyOptions {
  /** A stable resource/text key retires results when the content changes. */
  scopeKey?: unknown;
  onCopied?: () => void;
  onFallback?: () => void;
}
type CopyScope = { key: unknown; active: boolean; controller: AbortController | null; version: number };
type CopyState = { scope: CopyScope; version: number; status: CopyStatus; text: string | null };
type Outcome = "copied" | "fallback" | "retired";

const COPY_TIMEOUT_MS = 5000;
const COPIED_DISPLAY_MS = 2000;
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Clipboard permission can remain pending; cancellation and the manual
 * fallback must still settle without waiting for the browser adapter.
 */
async function clipboardOutcome(text: string, signal: AbortSignal): Promise<Outcome> {
  if (signal.aborted) return "retired";
  let write: Promise<Outcome>;
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText !== "function") return "fallback";
    write = Promise.resolve(clipboard.writeText(text)).then<Outcome, Outcome>(() => "copied", () => "fallback");
  }
  catch { return "fallback"; }
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const stopped = new Promise<Outcome>(resolve => {
    abort = () => resolve("retired");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => resolve("fallback"), COPY_TIMEOUT_MS);
  });
  try { return await Promise.race([write, stopped]); }
  finally { clearTimeout(timer!); signal.removeEventListener("abort", abort!); }
}

/** Explicit copy with a visible, selected-input fallback. No mount writes,
 * native prompts or offscreen execCommand elements. A retired operation can
 * never deliver success/fallback UI into a newer resource or unmounted view.
 */
export function useCopy(options: UseCopyOptions = {}) {
  const latest = useRef(options); latest.current = options;
  const scopeRef = useRef<CopyScope>({ key: options.scopeKey, active: false, controller: null, version: 0 });
  let scope = scopeRef.current;
  if (scope.key !== options.scopeKey) {
    scope.active = false;
    scope = { key: options.scopeKey, active: false, controller: null, version: 0 };
    scopeRef.current = scope;
  }
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [state, setState] = useState<CopyState>({ scope, version: 0, status: "idle", text: null });
  const status = state.scope === scope ? state.status : "idle";
  const fallbackText = state.scope === scope && state.status === "fallback" ? state.text : null;
  useClientLayoutEffect(() => {
    scope.active = true;
    return () => { scope.active = false; scope.controller?.abort(); scope.controller = null; };
  }, [scope]);
  useClientLayoutEffect(() => {
    if (fallbackText === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [fallbackText, state.version]);
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => {
      if (scope.active && scopeRef.current === scope && scope.version === state.version) {
        setState({ scope, version: state.version, status: "idle", text: null });
      }
    }, COPIED_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [status, scope, state.version]);

  const clear = useCallback(() => {
    scope.controller?.abort();
    scope.controller = null;
    scope.version += 1;
    if (scope.active && scopeRef.current === scope) setState({ scope, version: scope.version, status: "idle", text: null });
  }, [scope]);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!scope.active || scopeRef.current !== scope) return false;
    scope.controller?.abort();
    const controller = new AbortController();
    scope.controller = controller;
    const version = ++scope.version;
    setState({ scope, version, status: "copying", text: null });
    const outcome = await clipboardOutcome(text, controller.signal);
    if (!scope.active || scopeRef.current !== scope || scope.controller !== controller || outcome === "retired") return false;
    scope.controller = null;
    setState({ scope, version, status: outcome, text: outcome === "fallback" ? text : null });
    if (outcome === "copied") latest.current.onCopied?.();
    else latest.current.onFallback?.();
    return outcome === "copied";
  }, [scope]);
  return { copy, clear, status, copied: status === "copied", pending: status === "copying", fallbackText, inputRef };
}
