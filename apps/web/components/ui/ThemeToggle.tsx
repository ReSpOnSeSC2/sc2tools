"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import {
  THEME_STORAGE_KEY,
  type Theme,
  getTheme,
  toggleTheme,
} from "@/lib/theme";

/**
 * ThemeToggle — light/dark switch wired to lib/theme.
 * Subscribes to the storage event so the toggle stays in sync across tabs.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setMounted(true);
    setTheme(getTheme());

    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) {
        setTheme(getTheme());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Render the same DOM shape on server + client to avoid hydration
  // mismatch; the icon swaps after mount.
  const isDark = theme === "dark";
  const Label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={() => {
        const next = toggleTheme();
        setTheme(next);
      }}
      aria-label={Label}
      aria-pressed={mounted ? !isDark : undefined}
      title={Label}
      className={[
        "inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "border border-border bg-bg-elevated text-text-muted",
        "hover:bg-bg-subtle hover:text-text",
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-4 w-4" aria-hidden />
        ) : (
          <Moon className="h-4 w-4" aria-hidden />
        )
      ) : (
        <span className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
