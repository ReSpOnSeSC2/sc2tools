"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Twitch, Youtube } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { formatOffset } from "@/lib/vodLinks";
import type { GameStreamLink } from "./GameStreamLinks";

type SafeLink = GameStreamLink & { href: string; key: string };
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The header uses one action; the existing replay-row chips stay unchanged. */
export function GameVodToolbar({ links, className }: { links: SafeLink[]; className?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wanted = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useClientLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - (menu.current?.offsetHeight ?? 0) - 8)), left: Math.max(8, Math.min(rect.right - 288, window.innerWidth - 296)) });
    const controls = items();
    controls[wanted.current < 0 ? controls.length - 1 : 0]?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    const moved = () => close();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", moved); };
  }, [open]);
  if (links.length === 1) {
    const link = links[0];
    const Platform = link.platform === "twitch" ? Twitch : Youtube;
    return <a href={link.href} target="_blank" rel="noopener noreferrer" title={vodLabel(link)} className={buttonClassName({ variant: "secondary", size: "sm", className })} onClick={(event) => event.stopPropagation()}><Platform className="h-4 w-4" aria-hidden />Watch VOD</a>;
  }
  return <>
    <Button ref={trigger} variant="secondary" size="sm" className={className} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={(event) => { event.stopPropagation(); wanted.current = 0; if (open) close(); else setOpen(true); }}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); wanted.current = event.key === "ArrowUp" ? -1 : 0; setOpen(true); } }} iconRight={<ChevronDown className="h-4 w-4" aria-hidden />}>VODs</Button>
    {open ? createPortal(<div ref={menu} id={id} role="menu" aria-label="Game VODs" style={position} className="fixed z-[80] flex max-h-[70vh] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto rounded-lg border-2 border-line bg-bg-surface p-1 shadow-hard"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const controls = items(); const index = controls.indexOf(document.activeElement as HTMLAnchorElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}>
      {links.map((link) => <a key={link.key} role="menuitem" tabIndex={-1} href={link.href} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.stopPropagation(); close(); }} className="min-h-11 rounded px-3 py-2 text-caption text-text hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none">{vodLabel(link)}</a>)}
    </div>, document.body) : null}
  </>;
}

function vodLabel(link: SafeLink) {
  return `${link.perspective === "me" ? "You" : "Opponent"} · ${link.platform === "twitch" ? "Twitch" : "YouTube"} · ${formatOffset(link.offsetSec * 1000)}${link.playerName?.trim() ? ` · ${link.playerName.trim()}` : ""}`;
}
