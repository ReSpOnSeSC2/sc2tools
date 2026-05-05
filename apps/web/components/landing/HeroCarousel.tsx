"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * HeroCarousel — landing hero carousel.
 *
 * Behaviour:
 *   - Auto-advances every `intervalMs` milliseconds (paused while
 *     hovered/focused or when prefers-reduced-motion is set).
 *   - Manual nav arrows + dot indicators below.
 *   - Keyboard: ←/→ navigate, Home/End jump to first/last.
 *   - Each slide is rendered with `aria-hidden` when off-screen so
 *     screen readers only announce the active panel.
 *
 * The slides themselves are passed in as children so the carousel
 * stays presentation-only — the landing page composes brand-specific
 * slides without HeroCarousel having to know about them.
 */

export interface HeroCarouselSlide {
  id: string;
  /** Used for the dot label and the live region announcement. */
  label: string;
  content: ReactNode;
}

export interface HeroCarouselProps {
  slides: ReadonlyArray<HeroCarouselSlide>;
  /** Auto-advance interval; default 7000ms. Set 0 to disable. */
  intervalMs?: number;
  /** ARIA label for the whole carousel region. */
  ariaLabel?: string;
}

export function HeroCarousel({
  slides,
  intervalMs = 7000,
  ariaLabel = "Product highlights",
}: HeroCarouselProps) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const total = slides.length;
  const safeActive = total > 0 ? ((active % total) + total) % total : 0;

  const goTo = useCallback(
    (next: number) => {
      if (total === 0) return;
      setActive(((next % total) + total) % total);
    },
    [total],
  );
  const goNext = useCallback(() => goTo(safeActive + 1), [goTo, safeActive]);
  const goPrev = useCallback(() => goTo(safeActive - 1), [goTo, safeActive]);

  // Auto-advance
  useEffect(() => {
    if (intervalMs <= 0 || paused || total <= 1) return;
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    if (reduced) return;
    const handle = window.setInterval(() => {
      setActive((cur) => (cur + 1) % total);
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs, paused, total]);

  if (total === 0) return null;

  return (
    <section
      ref={containerRef}
      aria-roledescription="carousel"
      aria-label={ariaLabel}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (
          !containerRef.current ||
          !containerRef.current.contains(e.relatedTarget as Node | null)
        ) {
          setPaused(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          goNext();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          goPrev();
        } else if (e.key === "Home") {
          e.preventDefault();
          goTo(0);
        } else if (e.key === "End") {
          e.preventDefault();
          goTo(total - 1);
        }
      }}
      className="relative"
    >
      <div
        aria-live="polite"
        className="relative overflow-hidden rounded-2xl border border-accent/30 bg-bg-elevated/40 shadow-halo-accent"
      >
        <ul className="relative" role="list">
          {slides.map((slide, i) => {
            const isActive = i === safeActive;
            return (
              <li
                key={slide.id}
                role="group"
                aria-roledescription="slide"
                aria-label={`${slide.label} — ${i + 1} of ${total}`}
                aria-hidden={!isActive}
                className={[
                  "transition-opacity duration-500 motion-reduce:transition-none",
                  isActive
                    ? "relative opacity-100"
                    : "pointer-events-none absolute inset-0 opacity-0",
                ].join(" ")}
              >
                {slide.content}
              </li>
            );
          })}
        </ul>

        {total > 1 ? (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous slide"
              className={NAV_BTN_CLS + " left-2 sm:left-3"}
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next slide"
              className={NAV_BTN_CLS + " right-2 sm:right-3"}
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      {total > 1 ? (
        <div
          role="tablist"
          aria-label="Slide selector"
          className="mt-3 flex items-center justify-center gap-2"
        >
          {slides.map((slide, i) => {
            const isActive = i === safeActive;
            return (
              <button
                key={slide.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`carousel-slide-${slide.id}`}
                onClick={() => goTo(i)}
                className={[
                  "h-2 rounded-full transition-all motion-reduce:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  isActive
                    ? "w-8 bg-accent-cyan shadow-halo-cyan"
                    : "w-2 bg-border hover:bg-border-strong",
                ].join(" ")}
              >
                <span className="sr-only">Go to {slide.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

const NAV_BTN_CLS = [
  "absolute top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center",
  "rounded-full border border-border bg-bg-surface/80 text-text shadow-md backdrop-blur",
  "hover:bg-bg-surface hover:border-accent-cyan",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");
