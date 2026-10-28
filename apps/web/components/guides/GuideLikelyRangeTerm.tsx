"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { canReturnFocus } from "@/lib/a11y/focusScopes";
import { loadGuideLegendTerm } from "./loadGuideLegendTerm";

const LOAD_TIMEOUT_MS = 8_000;
type LoadedTerm = Awaited<ReturnType<typeof loadGuideLegendTerm>>;

/** The native disclosure and readable text work before its optional code loads. */
export function GuideLikelyRangeTerm({ label, loadingLabel, errorLabel, retryLabel }: {
  label: string; loadingLabel: string; errorLabel: string; retryLabel: string;
}) {
  const root = useRef<HTMLSpanElement>(null), retryFocus = useRef<HTMLButtonElement | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const [requested, setRequested] = useState(false), [attempt, setAttempt] = useState(0);
  const [Term, setTerm] = useState<LoadedTerm | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const details = root.current?.closest("details");
    if (!details) return;
    const onToggle = () => { if (details.open) setRequested(true); };
    onToggle();
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, []);
  useEffect(() => {
    if (!requested) return;
    let active = true, settled = false;
    const fail = () => {
      if (!active || settled) return;
      settled = true; window.clearTimeout(timer); setFailed(true);
    };
    const timer = window.setTimeout(fail, LOAD_TIMEOUT_MS);
    void loadGuideLegendTerm().then(term => {
      if (!active || settled) return;
      settled = true; window.clearTimeout(timer); setTerm(() => term);
    }).catch(fail);
    return () => { active = false; window.clearTimeout(timer); };
  }, [requested, attempt]);
  useLayoutEffect(() => {
    const previous = retryFocus.current;
    if (!previous || (!Term && !failed)) return;
    retryFocus.current = null;
    if (!root.current?.closest("details")?.open) return;
    const target = Term ? root.current.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]') : retryButton.current;
    const active = document.activeElement;
    if (target && canReturnFocus(target) && (active === previous || active === document.body && !previous.isConnected)) target.focus();
  }, [Term, failed]);
  return <span ref={root} className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
    {Term ? <Term id="likely-range">{label}</Term> : <>
      <span className="underline decoration-dotted underline-offset-4">{label}</span>
      {requested ? failed ? <>
        <span role="alert" className="font-normal text-text-muted">{errorLabel}</span>
        <Button ref={retryButton} variant="ghost" onClick={event => {
          retryFocus.current = event.currentTarget; setFailed(false); setAttempt(value => value + 1);
        }}>{retryLabel}</Button>
      </> : <span role="status" className="font-normal text-text-muted">{loadingLabel}</span> : null}
    </>}
  </span>;
}
