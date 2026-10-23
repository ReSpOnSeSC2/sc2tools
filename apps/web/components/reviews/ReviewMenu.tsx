"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type ReviewMenuItem = {
  id: string; label: string; href?: string; target?: string; rel?: string; disabled?: boolean;
  items?: ReviewMenuItem[]; onSelect?: () => unknown | Promise<unknown>;
  /** Async copy actions keep the popup open when they return false. */
  keepOpen?: boolean;
};

/** Small menu button with a second step, keyboard navigation and a copy fallback. */
export function ReviewMenu({ label, children, items, disabled, className, onActivate, fallbackText, onClose }: {
  label: string; children: ReactNode; items: ReviewMenuItem[]; disabled?: boolean; className?: string;
  onActivate?: () => boolean | Promise<boolean>; fallbackText?: string | null; onClose?: () => void;
}) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const wanted = useRef(0);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ReviewMenuItem[] | null>(null);
  const [up, setUp] = useState(false);
  const [shift, setShift] = useState(0);
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  function close(restore = true) {
    setOpen(false); setStep(null); onClose?.();
    if (restore) trigger.current?.focus();
  }
  const focusable = () => Array.from(popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = popup.current?.getBoundingClientRect();
    const button = trigger.current?.getBoundingClientRect();
    if (rect && button) {
      setUp(window.innerHeight - button.bottom < Math.min(rect.height, window.innerHeight * .7) + 8);
      setShift(Math.max(0, 8 - rect.left) - Math.max(0, rect.right - (window.innerWidth - 8)));
    }
    const controls = focusable();
    controls[wanted.current < 0 ? controls.length - 1 : 0]?.focus();
  }, [open, step]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
    // The listener uses current refs; changing action arrays must not reset focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { if (open && fallbackText) { fallback.current?.focus(); fallback.current?.select(); } }, [open, fallbackText]);

  async function activate() {
    if (open) { close(); return; }
    if (onActivate && await onActivate()) return;
    wanted.current = 0; setStep(null); setShift(0); setOpen(true);
  }
  async function choose(item: ReviewMenuItem) {
    if (pending || item.disabled) return;
    if (item.items) { wanted.current = 0; setShift(0); setStep(item.items); return; }
    if (!item.keepOpen) { close(); await item.onSelect?.(); return; }
    setPending(true);
    try { if (await item.onSelect?.() !== false) close(); }
    finally { setPending(false); }
  }
  if (!items.length) return null;
  return <span ref={root} className="relative inline-flex shrink-0">
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} disabled={disabled}
      className={className ?? "grid min-h-10 min-w-10 place-items-center rounded-full text-text-muted hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
      onClick={() => void activate()} onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); wanted.current = event.key === "ArrowUp" ? -1 : 0; setStep(null); setShift(0); setOpen(true); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void activate(); }
      }}>{children}</button>
    {open ? <div ref={popup} id={id} role="menu" aria-label={label} aria-busy={pending || undefined}
      className={`absolute right-0 z-50 flex max-h-[70vh] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-lg border-2 border-line bg-bg-surface p-1 shadow-hard ${up ? "bottom-full mb-1" : "top-full mt-1"}`} style={{ transform: shift ? `translateX(${shift}px)` : undefined }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        if (event.target === fallback.current || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const controls = focusable(); const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}>
      {(step ?? items).map((item) => item.href ? <a key={item.id} role="menuitem" tabIndex={active === item.id ? 0 : -1} onFocus={() => setActive(item.id)} href={item.href} target={item.target} rel={item.rel} onClick={() => void choose(item)} className="flex min-h-10 items-center rounded px-3 py-2 text-left text-caption font-semibold text-text hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none">{item.label}</a> : <button key={item.id} type="button" role="menuitem" tabIndex={active === item.id ? 0 : -1} onFocus={() => setActive(item.id)} disabled={pending || item.disabled} onClick={() => void choose(item)} className="min-h-10 rounded px-3 py-2 text-left text-caption font-semibold text-text hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none disabled:opacity-50">{item.label}</button>)}
      {fallbackText ? <div role="none" className="space-y-1 p-2"><label htmlFor={`${id}-copy`} className="text-micro text-text-muted">Copy this text</label><input ref={fallback} id={`${id}-copy`} readOnly value={fallbackText} className="min-h-10 w-full rounded border border-line bg-bg px-2 text-caption text-text" onFocus={(event) => event.currentTarget.select()} /></div> : null}
    </div> : null}
  </span>;
}

export const REPORT_REASONS = ["Spam", "Abusive or hateful", "Off-topic", "Reveals someone's identity", "Other"] as const;
