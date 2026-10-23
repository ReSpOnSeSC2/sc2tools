"use client";

import { useEffect, useState, type ReactNode } from "react";
import { GlowHalo } from "@/components/ui";
import { getTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export interface AuthShellProps {
  /** Right-column content, collapsed after the widget on phones. */
  marketing: ReactNode;
  /** One value line above the form on phones. */
  lead: ReactNode;
  /**
   * Render-prop for the Clerk widget. Receives the resolved theme so
   * callers can key the widget on it and pick the matching appearance.
   */
  children: (theme: Theme) => ReactNode;
}

/**
 * AuthShell — split-screen chrome around a Clerk widget.
 *
 * Layout and focus order: lead, widget, then marketing. On phones the
 * marketing content lives in a disclosure; desktop keeps the right column.
 *
 * Theme handling:
 *   - The Clerk widget is gated until the post-mount theme resolves,
 *     avoiding a wrong-theme flash during hydration.
 *   - A storage listener picks up theme changes from other tabs (and
 *     ThemeToggle's synthetic event in the same tab).
 */
export function AuthShell({ lead, marketing, children }: AuthShellProps) {
  const [theme, setThemeState] = useState<Theme | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setThemeState(getTheme());
    const media = window.matchMedia("(min-width: 768px)");
    const updateLayout = () => setDesktop(media.matches);
    updateLayout();
    media.addEventListener("change", updateLayout);
    const handler = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setThemeState(getTheme());
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
      media.removeEventListener("change", updateLayout);
    };
  }, []);

  return (
    <section className="relative">
      <GlowHalo color="cyan" position="top-left" size={70} opacity={0.7} />
      <div className="relative flex flex-col gap-6 md:grid md:grid-cols-2 md:items-start md:gap-12 lg:gap-16">
        <div className="flex w-full justify-center md:justify-end">
          <div role="region" aria-label="Account form" className="w-full max-w-md">
            <p className="mb-4 text-body-lg font-semibold text-text md:hidden">{lead}</p>
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
        <details
          className="w-full"
          open={desktop || expanded}
          onToggle={(event) => { if (!desktop) setExpanded(event.currentTarget.open); }}
        >
          <summary className="flex min-h-11 cursor-pointer items-center text-body font-semibold text-accent-cyan md:hidden">
            Why sign up?
          </summary>
          <div className="pt-4 md:pt-0">{marketing}</div>
        </details>
      </div>
    </section>
  );
}
