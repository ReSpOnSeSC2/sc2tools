"use client";
import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { getTheme, getThemeMode, setTheme, subscribeTheme, type Theme, type ThemeMode } from "@/lib/theme";
import { Modal } from "./Modal";
import { Button } from "./Button";
const modes = ["light", "dark", "system"] as const;
const choices = { light: { label: "Light", Icon: Sun }, dark: { label: "Dark", Icon: Moon }, system: { label: "System", Icon: Monitor } };
const snapshot = () => `${getThemeMode()}:${getTheme()}`;
export function useThemeState() {
  const [mode, theme] = useSyncExternalStore(subscribeTheme, snapshot, () => "system:dark").split(":");
  return { mode: mode as ThemeMode, theme: theme as Theme };
}
export function ThemeChoice({ className = "" }: { className?: string }) {
  const { mode } = useThemeState();
  return <div className={`min-w-0 space-y-2 ${className}`}>
    <p className="text-caption font-semibold text-text-muted">Theme</p>
    <div role="radiogroup" aria-label="Theme" tabIndex={-1} className="grid grid-cols-3 gap-1 rounded-xl border border-border p-1" onKeyDown={event => {
      const index = modes.indexOf(mode);
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % 3 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + 2) % 3 : null;
      if (next === null) return;
      event.preventDefault(); setTheme(modes[next]); event.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-option="${modes[next]}"]`)?.focus();
    }}>
      {modes.map(value => { const { label, Icon } = choices[value]; return <button key={value} type="button" role="radio" aria-checked={mode === value} data-theme-option={value} tabIndex={mode === value ? 0 : -1} onClick={() => setTheme(value)} className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-lg px-2 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${mode === value ? "bg-accent text-white" : "text-text hover:bg-bg-elevated"}`}><Icon className="h-4 w-4 shrink-0" aria-hidden />{label}</button>; })}
    </div>
    {mode === "system" ? <p className="text-caption text-text-muted">Follows your device appearance.</p> : null}
  </div>;
}
export function ThemeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose} title="Appearance" size="sm" footer={<Button onClick={onClose}>Done</Button>}><ThemeChoice /></Modal>;
}
