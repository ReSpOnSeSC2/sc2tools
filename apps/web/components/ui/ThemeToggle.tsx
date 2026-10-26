"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { toggleTheme } from "@/lib/theme";
import { ThemeDialog, useThemeState } from "./ThemeChoice";

/** One click flips the palette; hold/right-click/Arrow Down opens all modes. */
export function ThemeToggle({ className = "", size = "md" }: { className?: string; size?: "sm" | "md" }) {
  const { theme } = useThemeState();
  const [open, setOpen] = useState(false);
  const hintId = useId();
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), consumed = useRef(false);
  const clear = () => { clearTimeout(hold.current); hold.current = undefined; };
  useEffect(() => clear, []);
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return <><button type="button" onClick={event => { const held = consumed.current; consumed.current = false; if (held && event.detail !== 0) return; toggleTheme(); }}
    onPointerDown={event => { if (event.button !== 0) return; clear(); consumed.current = false; hold.current = setTimeout(() => { consumed.current = true; setOpen(true); }, 500); }}
    onPointerUp={clear} onPointerCancel={clear} onPointerLeave={clear}
    onContextMenu={event => { event.preventDefault(); clear(); setOpen(true); }}
    onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); clear(); setOpen(true); } }}
    aria-label={label} aria-describedby={hintId}
    aria-expanded={open} aria-pressed={theme === "light"} title={`${label} · hold for System options`}
    className={`hard-press inline-flex ${size === "sm" ? "h-8 w-8" : "h-9 w-9"} items-center justify-center rounded-full border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${className}`}>
    {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
  </button><span id={hintId} className="sr-only">Press and hold, right-click, or press Arrow Down for Light, Dark and System options.</span><ThemeDialog open={open} onClose={() => setOpen(false)} /></>;
}
