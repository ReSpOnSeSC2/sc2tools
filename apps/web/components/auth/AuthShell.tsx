"use client";

import { useEffect, useState, type ReactNode } from "react";
import { GlowHalo } from "@/components/ui";
import { getTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export interface AuthShellProps {
  /** Right-column marketing content (mobile: stacked above the widget). */
  marketing: ReactNode;
  /**
   * Render-prop for the Clerk widget. Receives the resolved theme so
   * callers can key the widget on it and pick the matching appearance.
   */
  children: (theme: Theme) => ReactNode;
}

/**
 * AuthShell — split-screen chrome around a Clerk widget.
 *
 * Layout:
 *   - Mobile: single column, marketing panel above the widget.
 *   - Desktop (≥md): two columns, widget on the left, marketing on
 *     the right. DOM order is `widget → marketing` so the grid lays
 *     them out naturally; on mobile we use `flex-col-reverse` to put
 *     marketing visually first without changing focus order.
 *
 * Theme handling:
 *   - The Clerk widget is gated until the post-mount theme resolves,
 *     avoiding a wrong-theme flash during hydration.
 *   - A storage listener picks up theme changes from other tabs (and
 *     ThemeToggle's synthetic event in the same tab).
 */
export function AuthShell({ marketing, children }: AuthShellProps) {
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    setThemeState(getTheme());
    const handler = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setThemeState(getTheme());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <section className="relative">
      <GlowHalo color="cyan" position="top-left" size={70} opacity={0.7} />
      <div className="relative flex flex-col-reverse gap-10 md:grid md:grid-cols-2 md:items-start md:gap-12 lg:gap-16">
        <div className="flex w-full justify-center md:justify-end">
          <div className="w-full max-w-md">
            {theme !== null ? (
              children(theme)
            ) : (
              <div
                className="min-h-[480px] rounded-xl border border-border bg-bg-surface/40"
                aria-hidden
              />
            )}
          </div>
        </div>
        <div className="w-full">{marketing}</div>
      </div>
    </section>
  );
}
