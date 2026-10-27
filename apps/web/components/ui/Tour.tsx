"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
import type { TourStep } from "@/lib/tours";
import { Button } from "./Button";
import { useOverlayLayer } from "./OverlayLayer";

type Bounds = { top: number; left: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
type Props = {
  title: string; step: TourStep; target: HTMLElement; index: number; total: number;
  pending: boolean; error: string | null; onBack: () => void; onNext: () => void;
  onFinish: () => void; onSkip: () => void; onTargetLost: () => void; canReveal: () => boolean;
};

/** A tour is a modal explanation of a real target, with the same focus scope as other dialogs. */
export function Tour({ title, step, target, index, total, pending, error, onBack, onNext, onFinish, onSkip, onTargetLost, canReveal }: Props) {
  const panel = useRef<HTMLDivElement>(null), firstControl = useRef<HTMLButtonElement>(null);
  const latest = useRef({ pending, onSkip, onTargetLost, canReveal }); latest.current = { pending, onSkip, onTargetLost, canReveal };
  const unsafeReveal = useRef(false);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const titleId = useId(), descriptionId = useId(), layer = useOverlayLayer();
  useFocusTrap({ open: canReveal(), containerRef: panel, initialFocusRef: firstControl,
    onClose: () => { if (!latest.current.pending) latest.current.onSkip(); },
    restoreFocus: () => !unsafeReveal.current && latest.current.canReveal() ? "if-lost" : false });
  useEffect(() => lockBodyScroll(), []);
  useLayoutEffect(() => {
    let active = true, frame: number | null = null;
    const measure = () => {
      frame = null;
      if (!active) return;
      if (!latest.current.canReveal()) { unsafeReveal.current = true; latest.current.onTargetLost(); return; }
      const rect = target.getBoundingClientRect();
      if (!target.isConnected || rect.width <= 0 || rect.height <= 0 || target.closest("[hidden],[inert],[aria-hidden='true']")) { latest.current.onTargetLost(); return; }
      const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
      const left = Math.max(4, Math.min(viewportWidth - 4, rect.left - 6));
      const top = Math.max(4, Math.min(viewportHeight - 4, rect.top - 6));
      setBounds({ left, top, width: Math.max(0, Math.min(viewportWidth - 4, rect.right + 6) - left), height: Math.max(0, Math.min(viewportHeight - 4, rect.bottom + 6) - top), viewportWidth, viewportHeight });
    };
    const schedule = () => { if (active && frame === null) frame = requestAnimationFrame(measure); };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!latest.current.canReveal()) { unsafeReveal.current = true; latest.current.onTargetLost(); return; }
    const rect = target.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    if (!visible) {
      // Preserve visible targets, including sticky and tall sections. When a check-in exists, reveal in one
      // synchronous move so a smooth path cannot expose it between safe endpoints.
      const guarded = !!document.querySelector('[data-tour-blocker="check-in"]');
      const previous = [] as { element: HTMLElement; left: number; top: number }[];
      if (guarded) for (let element = target.parentElement; element; element = element.parentElement) previous.push({ element, left: element.scrollLeft, top: element.scrollTop });
      const left = window.scrollX, top = window.scrollY;
      target.scrollIntoView({ block: "start", inline: "nearest", behavior: reduced || guarded ? "instant" : "smooth" });
      if (!latest.current.canReveal()) {
        // Roll back before paint and decline the step rather than cover the card.
        for (const position of previous) position.element.scrollTo({ left: position.left, top: position.top, behavior: "instant" });
        window.scrollTo({ left, top, behavior: "instant" });
        unsafeReveal.current = true; latest.current.onTargetLost(); return;
      }
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(target); if (panel.current) observer?.observe(panel.current);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => { active = false; observer?.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); if (frame !== null) cancelAnimationFrame(frame); };
  }, [target]);

  if (typeof document === "undefined" || !canReveal()) return null;
  const phone = !!bounds && bounds.viewportWidth < 640;
  const width = bounds ? Math.min(360, bounds.viewportWidth - 24) : 360;
  const panelHeight = panel.current?.getBoundingClientRect().height ?? 260;
  const top = bounds ? Math.max(12, Math.min(bounds.viewportHeight - panelHeight - 12,
    bounds.top + bounds.height + panelHeight + 24 <= bounds.viewportHeight ? bounds.top + bounds.height + 12 : bounds.top - panelHeight - 12)) : 12;
  const placement = phone ? { left: 0, right: 0, bottom: 0 } : { width, left: bounds ? Math.max(12, Math.min(bounds.viewportWidth - width - 12, bounds.left)) : 12, top };
  return createPortal(<div className="fixed inset-0" style={{ zIndex: layer }} data-tour-overlay="true">
    <div aria-hidden="true" className="absolute inset-0" />
    {bounds ? <div aria-hidden="true" className="pointer-events-none fixed rounded-xl border-2 border-accent" style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.66)" }} /> : null}
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      data-tour-dialog="true" className="fixed flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-2xl border border-border bg-bg-surface p-5 text-text shadow-[var(--shadow-card)] sm:rounded-xl" style={placement}>
      <p className="text-caption text-text-muted">{title} · Step {index + 1} of {total}</p>
      <h2 id={titleId} className="mt-1 text-h4 font-semibold">{step.title}</h2>
      <p id={descriptionId} className="mt-3 text-body-sm text-text-muted">{step.text}</p>
      {step.help ? <Link href={step.help} className="mt-2 inline-flex min-h-11 items-center rounded text-caption font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Read the guide</Link> : null}
      {error ? <p role="alert" className="mt-3 text-body-sm text-danger">{error}</p> : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pb-[env(safe-area-inset-bottom,0px)]">
        <Button ref={firstControl} variant="ghost" size="sm" aria-disabled={pending || undefined} onClick={() => { if (!pending) onSkip(); }}>{pending ? "Saving…" : "Skip tour"}</Button>
        <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={index === 0 || pending} onClick={onBack}>Back</Button>
          <Button size="sm" disabled={pending} onClick={index === total - 1 ? onFinish : onNext}>{index === total - 1 ? "Finish" : "Next"}</Button></div>
      </div>
    </div>
  </div>, document.body);
}
