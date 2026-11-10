"use client";

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Share2 } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { popoverPlacement } from "@/lib/a11y/popoverPlacement";

/**
 * One row of a share menu. Hosts build the rows as an array so later
 * features only append (game page, Replay Library rows).
 */
export interface ShareMenuItem {
  id: string;
  label: string;
  /** One short line under the label: who can open what. */
  sublabel?: string;
  icon?: ReactNode;
  /** Link rows navigate (Help); action rows run ``onSelect``. */
  href?: string;
  onSelect?: () => unknown;
  /** Work in flight: a spinner, aria-disabled, and the menu stays open. */
  busy?: boolean;
  disabled?: boolean;
  /** Keep the menu open while ``onSelect`` runs (it shows its own progress). */
  keepOpen?: boolean;
}

export interface ShareMenuHandle {
  /** The trigger, for dialogs opened from a row to return focus to. */
  trigger: HTMLButtonElement | null;
}

const PHONE_QUERY = "(max-width: 639px)";
const PANEL_WIDTH = 320;

type Placement = ReturnType<typeof popoverPlacement>;

/**
 * Menu button: ``aria-haspopup="menu"`` trigger, ``role="menu"`` panel of
 * 44px ``menuitem`` rows. Arrow keys, Home and End move between rows;
 * Escape, Tab and an outside click close it and return focus to the
 * trigger. The panel is portalled and clamped to the viewport, so table
 * rows and scrolling containers never clip it; on phones it is a bottom
 * sheet. No motion, so reduced-motion needs no special case.
 */
export const ShareMenu = forwardRef<ShareMenuHandle, {
  items: ShareMenuItem[];
  /** Visible trigger text and the menu's name. */
  label?: string;
  /** Trigger name when it should say more than ``label`` (dense rows). */
  ariaLabel?: string;
  /** Icon-only trigger for dense rows. */
  compact?: boolean;
  className?: string;
  /** Fires when the menu opens (lazy reads for the rows). */
  onOpen?: () => void;
}>(function ShareMenu({ items, label = "Share", ariaLabel, compact = false, className, onOpen }, ref) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const focusTarget = useRef<"first" | "last">("first");
  useImperativeHandle(ref, () => ({ get trigger() { return trigger.current; } }), []);

  const rows = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  const show = (target: "first" | "last") => {
    focusTarget.current = target;
    setOpen(true);
    onOpen?.();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const media = typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
    const update = () => {
      const isPhone = !!media?.matches;
      setPhone(isPhone);
      const anchor = trigger.current?.getBoundingClientRect();
      if (isPhone || !anchor || !panel.current) { setPlacement(null); return; }
      setPlacement(popoverPlacement(anchor, panel.current.scrollHeight || panel.current.getBoundingClientRect().height,
        { width: window.innerWidth, height: window.innerHeight }, PANEL_WIDTH));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, items.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const list = rows();
    (focusTarget.current === "last" ? list[list.length - 1] : list[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close(true);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, close]);

  const choose = async (item: ShareMenuItem) => {
    if (item.busy || item.disabled) return;
    if (item.href) { setOpen(false); return; }
    if (!item.keepOpen) { close(true); await item.onSelect?.(); return; }
    // Work that keeps the menu open closes it when done; return false to
    // stay open. A dialog that took focus meanwhile keeps it.
    if (await item.onSelect?.() === false) return;
    close(!!panel.current?.contains(document.activeElement));
  };

  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { event.preventDefault(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const list = rows();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1
      : (index + (event.key === "ArrowUp" ? -1 : 1) + list.length) % list.length;
    list[next]?.focus();
  };

  if (!items.length) return null;
  const rowClass = "flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-text hover:bg-bg-elevated focus:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
  const content = (item: ShareMenuItem) => <>
    <span aria-hidden className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
      {item.busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : item.icon}
    </span>
    <span className="min-w-0">
      <span className="block text-caption font-semibold">{item.label}</span>
      {item.sublabel ? <span className="block text-caption text-text-muted">{item.sublabel}</span> : null}
    </span>
  </>;
  const panelStyle = phone || !placement ? undefined
    : { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight };
  return <>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={ariaLabel ?? (compact ? label : undefined)}
      className={className ?? buttonClassName({ variant: "secondary", size: "sm", className: compact ? "min-w-11 px-2" : undefined })}
      onClick={() => (open ? close(true) : show("first"))}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          show(event.key === "ArrowUp" ? "last" : "first");
        }
      }}>
      <Share2 className="h-4 w-4" aria-hidden />
      {compact ? null : <><span>{label}</span><ChevronDown className="h-3.5 w-3.5" aria-hidden /></>}
    </button>
    {open ? createPortal(<>
      {phone ? <div aria-hidden className="fixed inset-0 z-50 bg-black/40" /> : null}
      <div ref={panel} id={id} role="menu" aria-label={label} tabIndex={-1} onKeyDown={onPanelKey}
        className={phone
          ? "fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-surface p-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-lg"
          : "fixed z-50 overflow-y-auto rounded-xl border border-border bg-bg-surface p-1 shadow-lg"}
        style={panelStyle ?? (phone ? undefined : { visibility: "hidden", width: PANEL_WIDTH })}>
        {items.map((item) => item.href
          ? <a key={item.id} role="menuitem" tabIndex={-1} href={item.href} className={rowClass}
            aria-disabled={item.disabled || undefined} onClick={() => void choose(item)}>{content(item)}</a>
          : <button key={item.id} type="button" role="menuitem" tabIndex={-1} className={rowClass}
            aria-disabled={item.busy || item.disabled || undefined} aria-busy={item.busy || undefined}
            onClick={() => void choose(item)}>{content(item)}</button>)}
      </div>
    </>, document.body) : null}
  </>;
});
