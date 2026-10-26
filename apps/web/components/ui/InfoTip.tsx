"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { IconButton } from "./IconButton";
import { Popover } from "./Popover";
import type { GlossaryTerm } from "@/lib/glossary";
import { canReturnFocus } from "@/lib/a11y/focusScopes";

const DEFINITION_TIMEOUT_MS = 8_000;
type DefinitionScope = { termId: string; open: boolean; attempt: number };
type Answer = { scope: DefinitionScope; term: GlossaryTerm | null; failed: boolean };

/** Short contextual help. Only an explicit open imports the definitions;
 * closing, changing the term or retrying retires a held chunk result.
 */
export function InfoTip({ termId, label }: { termId: string; label: string }) {
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const scope = useMemo(() => ({ termId, open, attempt }), [termId, open, attempt]);
  const current = useRef(scope); current.current = scope;
  const trigger = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null), moreLink = useRef<HTMLAnchorElement>(null);
  const retryFocus = useRef<{ termId: string; attempt: number; target: HTMLButtonElement } | null>(null);
  const popoverId = useId(), descriptionId = useId();
  const result = answer?.scope === scope ? answer : null;
  useEffect(() => {
    if (!open) return;
    let active = true, settled = false;
    const publish = (term: GlossaryTerm | null, failed: boolean) => {
      if (!active || settled || current.current !== scope) return;
      settled = true; window.clearTimeout(timer); setAnswer({ scope, term, failed });
    };
    const timer = window.setTimeout(() => publish(null, true), DEFINITION_TIMEOUT_MS);
    void import("@/lib/glossary").then(({ glossaryTerm }) => {
      const term = glossaryTerm(termId);
      publish(term ?? null, !term);
    }).catch(() => publish(null, true));
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, scope, termId]);
  useLayoutEffect(() => {
    const request = retryFocus.current;
    if (!request) return;
    if (!open || request.termId !== termId || request.attempt !== attempt) { retryFocus.current = null; return; }
    if (!result) return;
    retryFocus.current = null;
    const target = result.term ? moreLink.current : retryButton.current;
    const active = document.activeElement;
    if (target && canReturnFocus(target) && (active === request.target || active === document.body && !request.target.isConnected)) target.focus();
  }, [open, termId, attempt, result]);
  return <>
    <IconButton ref={trigger} aria-label={`About ${label}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? popoverId : undefined} aria-describedby={open && result?.term ? descriptionId : undefined}
      onClick={() => setOpen(value => !value)}><CircleHelp className="h-4 w-4" /></IconButton>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={trigger} label={`About ${label}`} id={popoverId}
      portalContainer={typeof document === "undefined" ? undefined : document.body}>
      {result?.term ? <div className="space-y-3">
        <h3 className="text-body font-semibold text-text">{result.term.term}</h3>
        <p id={descriptionId} className="text-caption text-text-muted">{result.term.short}</p>
        <Link ref={moreLink} href={`/help/glossary#${encodeURIComponent(result.term.id)}`} className="inline-flex min-h-11 items-center rounded text-caption font-semibold text-accent-cyan underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Learn more</Link>
      </div> : result?.failed ? <div className="space-y-2">
        <p role="alert" className="text-caption text-text-muted">This definition could not be loaded.</p>
        <button ref={retryButton} type="button" onClick={event => {
          retryFocus.current = { termId, attempt: attempt + 1, target: event.currentTarget }; setAttempt(value => value + 1);
        }} className="min-h-11 rounded px-2 text-caption font-semibold text-accent-cyan underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry definition</button>
      </div> : <p role="status" className="text-caption text-text-muted">Loading definition…</p>}
    </Popover>
  </>;
}
