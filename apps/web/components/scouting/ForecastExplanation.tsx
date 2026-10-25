"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";

/** Portalled so a dossier card cannot clip the explanation or its close target. */
export function ForecastExplanation() {
  const [open, setOpen] = useState(false), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 80, width: 320, maxHeight: 480 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const box = trigger.current?.getBoundingClientRect(); if (!box) return;
      const width = Math.min(420, window.innerWidth - 16);
      const top = Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 280));
      setPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top, width, maxHeight: window.innerHeight - top - 8 });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useFocusTrap({ open, containerRef: panel, onClose: () => setOpen(false) });
  return <>
    <Button ref={trigger} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>How is this calculated?</Button>
    {open && typeof document !== "undefined" ? createPortal(<>
      <button type="button" tabIndex={-1} aria-label="Close forecast explanation" className="fixed inset-0 z-40" onMouseDown={event => event.preventDefault()} onClick={() => setOpen(false)} />
      <div ref={panel} id={id} role="dialog" aria-modal="true" aria-label="How the opening forecast works" tabIndex={-1} style={position} className="fixed z-50 space-y-3 overflow-y-auto rounded-xl border-2 border-line bg-bg-surface p-4 text-text shadow-card">
        <h3 className="text-body font-semibold">A forecast from recorded history</h3>
        <p className="text-caption text-text-muted">The source is your latest 50 matching metadata rows, ordered newest first. Hidden, deleted, resumed and other-matchup games do not use a slot. Short or invalid-duration observations then lower the sample; older games do not refill it.</p>
        <p className="text-caption text-text-muted">Newer observations count more. After eight eligible games, an observation has half its original weight. A game on the selected map counts 1.5 times as much. Unlabelled games keep their share.</p>
        <p className="text-caption text-text-muted">When available, the cached ladder mix adds three pseudo-games. It describes their race against your race and your recorded rating band. It does not increase your personal effective n.</p>
        <p className="text-caption text-text-muted">Confidence is Low below effective n=3, Medium from 3 to below 8, and High at 8 or more. The top three keep their share of all openings. These fixed rules cannot see what this opponent is building now.</p>
        <div className="flex flex-wrap items-center gap-2"><LazyHelpLink slug="opponent-scouting" anchor="how-the-forecast-works">Forecast guide</LazyHelpLink><Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Done</Button></div>
      </div>
    </>, document.body) : null}
  </>;
}
