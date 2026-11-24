"use client";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The horizontal slide group accepts keyboard scrolling. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { revealHorizontally } from "@/lib/a11y/revealHorizontally";

export interface HeroCarouselSlide { id: string; label: string; content: ReactNode }
export interface HeroCarouselProps { slides: ReadonlyArray<HeroCarouselSlide>; intervalMs?: number; ariaLabel?: string }

/** Swipe strip on phones, stable-height pausable slideshow on larger screens. */
export function HeroCarousel({ slides, intervalMs = 5500, ariaLabel = "Product highlights" }: HeroCarouselProps) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [visible, setVisible] = useState(true);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const total = slides.length;
  const current = total ? active % total : 0;
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 768px)");
    const update = () => setDesktop(media?.matches ?? true);
    update(); media?.addEventListener?.("change", update);
    const visibility = () => setVisible(!document.hidden);
    visibility(); document.addEventListener("visibilitychange", visibility);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setPaused(true);
    return () => { media?.removeEventListener?.("change", update); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const playing = desktop && !paused && visible && intervalMs > 0 && total > 1;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setActive((value) => (value + 1) % total), intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, intervalMs, total]);
  function go(next: number) {
    const index = (next + total) % total;
    setPaused(true); setActive(index);
    if (!desktop && strip.current) revealHorizontally(strip.current, strip.current.children[index] as HTMLElement);
  }
  if (!total) return null;
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Carousel arrow keys operate the focused strip and its controls.
  return <section aria-roledescription="carousel" aria-label={ariaLabel} aria-live={playing ? "off" : "polite"} className="relative isolate min-w-0"
    onKeyDown={(event) => { const next = event.key === "ArrowRight" ? current + 1 : event.key === "ArrowLeft" ? current - 1 : event.key === "Home" ? 0 : event.key === "End" ? total - 1 : null; if (next !== null) { event.preventDefault(); go(next); } }}>
    <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-8 bottom-4 -z-10 rounded-full bg-aurora opacity-20 blur-3xl" />
    <div className="group hud-corners glass relative overflow-hidden rounded-2xl border border-line shadow-pop">
      <div aria-hidden className="flex h-8 items-center gap-1.5 border-b border-border px-4">
        <span className="h-2 w-2 rounded-full bg-text-dim/40" /><span className="h-2 w-2 rounded-full bg-text-dim/40" /><span className="h-2 w-2 rounded-full bg-text-dim/40" />
      </div>
      <ul ref={strip} role="group" aria-label="Product highlight slides" tabIndex={0} className="grid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent max-md:flex max-md:snap-x max-md:snap-mandatory max-md:gap-3 max-md:overflow-x-auto"
        style={{ touchAction: desktop ? "pan-y" : "auto" }}
        onScroll={() => { if (!desktop) setPaused(true); }}
        onPointerDown={(event) => { pointer.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={(event) => { const from = pointer.current; pointer.current = null; if (!from || !desktop) return; const dx = event.clientX - from.x; const dy = event.clientY - from.y; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(current + (dx < 0 ? 1 : -1)); }}>
        {slides.map((slide, index) => <li key={slide.id} role="group" aria-roledescription="slide" aria-label={slide.label + " — " + (index + 1) + " of " + total}
          aria-hidden={desktop ? index !== current : undefined} inert={desktop && index !== current ? true : undefined}
          className={["col-start-1 row-start-1 min-w-0 transition-opacity duration-500 motion-reduce:transition-none max-md:w-[85%] max-md:shrink-0 max-md:snap-center max-md:opacity-100", index === current ? "opacity-100" : "md:pointer-events-none opacity-0"].join(" ")}>{slide.content}</li>)}
      </ul>
      {total > 1 ? <><button type="button" aria-label="Previous slide" onClick={() => go(current - 1)} className={NAV + " left-2"}><ChevronLeft aria-hidden className="h-5 w-5" /></button>
        <button type="button" aria-label="Next slide" onClick={() => go(current + 1)} className={NAV + " right-2"}><ChevronRight aria-hidden className="h-5 w-5" /></button></> : null}
    </div>
    {total > 1 ? <div role="group" aria-label="Slide selector" className="mt-3 hidden items-center justify-center gap-2 md:flex">
      {slides.map((slide, index) => <button key={slide.id} type="button" aria-label={"Show slide " + (index + 1) + " of " + total + ": " + slide.label} aria-current={index === current ? "true" : undefined}
        onClick={() => go(index)} className="inline-flex h-6 min-w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span aria-hidden className={index === current ? "h-1.5 w-8 rounded-full bg-aurora transition-all" : "h-1.5 w-3 rounded-full bg-border-strong/60 transition-all"} /></button>)}
      <button type="button" aria-label={paused ? "Play slideshow" : "Pause slideshow"} onClick={() => setPaused((value) => !value)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-bg-subtle/60 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{paused ? <Play aria-hidden className="h-5 w-5" /> : <Pause aria-hidden className="h-5 w-5" />}</button>
    </div> : null}
  </section>;
}
const NAV = "absolute top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border glass-strong text-text opacity-0 md:inline-flex group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
