"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";
import { isTopFocusLayer } from "@/lib/a11y/focusScopes";
import { popoverPlacement } from "@/lib/a11y/popoverPlacement";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { OverlayLayerProvider, useOverlayLayer } from "./OverlayLayer";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  id?: string;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** False lets a lazy consumer focus only after its content is ready. */
  autoFocus?: boolean;
  /** Custom hosts must permit normal stacking; ancestor CSS contexts can constrain a portal. */
  portalContainer?: Element | null;
  width?: number;
  className?: string;
}

/** A nonmodal dialog: Escape/outside dismissal without a Tab trap or body lock.
 * The trigger owns aria-expanded/aria-controls. An enclosing Modal retains Tab
 * containment, including when a custom portal container is outside that Modal.
 */
export function Popover({ open, onClose, anchorRef, label, id, children, initialFocusRef,
  autoFocus = true, portalContainer, width = 352, className = "" }: PopoverProps) {
  const layer = useOverlayLayer();
  const viewport = useVisualViewport(open && !portalContainer);
  const panelRef = useRef<HTMLDivElement>(null);
  const restore = useRef<true | "if-lost">(true);
  const [host, setHost] = useState<Element | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof popoverPlacement> | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) { setHost(null); setPosition(null); return; }
    restore.current = true;
    setHost(portalContainer ?? anchorRef.current?.closest('[role="dialog"]') ?? document.body);
  }, [open, portalContainer, anchorRef]);
  useLayoutEffect(() => {
    if (!open || !host) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setPosition(popoverPlacement(anchor.getBoundingClientRect(), panel.scrollHeight || panel.getBoundingClientRect().height,
        viewport ?? { width: window.innerWidth, height: window.innerHeight }, width));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); observer?.disconnect(); };
  }, [open, host, anchorRef, width, viewport]);
  useFocusTrap({ open: open && !!host && !!position, containerRef: panelRef, onClose,
    initialFocusRef, returnFocusRef: anchorRef, trapFocus: false, autoFocus,
    restoreFocus: () => restore.current });
  useLayoutEffect(() => {
    if (!open || !host) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !isTopFocusLayer(panelRef.current)
        || panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // Let the clicked control keep its normal pointer focus.
      restore.current = "if-lost";
      closeRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, host, anchorRef]);
  if (!open || !host) return null;
  return createPortal(<OverlayLayerProvider value={layer}><div ref={panelRef} id={id} role="dialog" aria-label={label} tabIndex={-1}
    className={["fixed z-50 overflow-y-auto rounded-xl border border-border bg-bg-surface p-4 text-text shadow-[var(--shadow-card)]", className].join(" ")}
    style={{ ...(position ?? { visibility: "hidden", width }), zIndex: layer }}>
    {children}
  </div></OverlayLayerProvider>, host);
}
