"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

/** Owner actions follow the library card's keyboard and viewport-safe menu pattern. */
export function CommunityOwnerMenu({ onRemove }: { onRemove: () => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const initialItem = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 280 });
  const close = useCallback((restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const height = menu.current?.offsetHeight || 104;
      const margin = 8; const below = window.innerHeight - box.bottom - margin;
      const top = below >= height ? box.bottom + 4 : Math.max(margin, box.top - height - 4);
      setPosition({ left: Math.max(margin, Math.min(box.right - 224, window.innerWidth - 224 - margin)), top, maxHeight: Math.max(44, window.innerHeight - top - margin) });
    };
    place();
    const frame = requestAnimationFrame(() => menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[initialItem.current]?.focus());
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, close]);
  function move(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return <span className="inline-flex items-center gap-1">
    <Badge size="sm" variant="neutral">Your build</Badge>
    <button ref={trigger} type="button" aria-label="Your build options" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initialItem.current = 0; setOpen((value) => !value); }}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); initialItem.current = event.key === "ArrowUp" ? 1 : 0; setOpen(true); } }}
      className="inline-flex min-h-[44px] w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><MoreHorizontal className="h-5 w-5" aria-hidden /></button>
    {open ? createPortal(<ul ref={menu} id={id} role="menu" aria-label="Your build actions" onKeyDown={move}
      onBlur={(event) => { if (event.relatedTarget instanceof Node && !menu.current?.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(); }}
      style={position} className="fixed z-[70] w-56 overflow-y-auto rounded-lg border border-border bg-bg-surface p-1 shadow-lg">
      <li role="none"><Link role="menuitem" tabIndex={-1} href="/builds" onClick={() => close()} className="flex min-h-11 items-center rounded-md px-3 text-caption text-text hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none">Open my library</Link></li>
      <li role="none"><button role="menuitem" tabIndex={-1} type="button" onClick={() => { close(true); onRemove(); }} className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-caption text-danger hover:bg-danger/10 focus:bg-danger/10 focus:outline-none">Remove from Community…</button></li>
    </ul>, document.body) : null}
  </span>;
}
