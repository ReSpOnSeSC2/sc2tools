"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { RecapSlide } from "./seasonRecapSlides";

interface RecapSlidesModalProps {
  slides: RecapSlide[];
  title: string;
  description: string;
  shareAction: ReactNode;
  onClose: () => void;
  compact?: boolean;
}

function useSlideNavigation(count: number) {
  const [index, setIndex] = useState(0);
  const go = useCallback(
    (delta: number) => setIndex((current) => Math.max(0, Math.min(count - 1, current + delta))),
    [count],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go]);
  return { index: Math.min(index, count - 1), go, setIndex };
}

function SlideTabs({ slides, index, onSelect }: {
  slides: RecapSlide[];
  index: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Recap slides">
      {slides.map((slide, position) => (
        <button
          key={slide.key}
          type="button"
          role="tab"
          aria-selected={position === index}
          aria-label={`Slide ${position + 1}: ${slide.headline}`}
          onClick={() => onSelect(position)}
          className={`h-2.5 w-2.5 rounded-full transition-colors ${
            position === index ? "bg-accent-cyan" : "bg-line hover:bg-border-strong"
          }`}
        />
      ))}
    </div>
  );
}

function SlideContent({ slide }: { slide: RecapSlide }) {
  return (
    <div className="min-w-0 space-y-2 break-words">
      {slide.eyebrow ? (
        <p className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">{slide.eyebrow}</p>
      ) : null}
      {slide.big ? (
        <p className="font-display text-display-lg font-bold tabular-nums text-text">{slide.big}</p>
      ) : null}
      <p className="text-h3 font-semibold text-text">{slide.headline}</p>
      {slide.sub ? <p className="mx-auto max-w-md text-body text-text-muted">{slide.sub}</p> : null}
    </div>
  );
}

export function RecapSlidesModal({ slides, title, description, shareAction, onClose, compact }: RecapSlidesModalProps) {
  const { index, go, setIndex } = useSlideNavigation(slides.length);
  const slide = slides[index];
  return (
    <Modal open onClose={onClose} title={title} description={description} size="lg">
      <div className="flex flex-col gap-4">
        <div
          className="relative flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-line bg-bg-elevated px-5 py-8 text-center motion-safe:transition-opacity"
          role="group"
          aria-roledescription="slide"
          aria-label={`${index + 1} of ${slides.length}: ${slide.headline}`}
          aria-live={compact ? "polite" : undefined}
        >
          <SlideContent slide={slide} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" className={compact ? "min-h-11" : undefined} onClick={() => go(-1)} disabled={index === 0}
            iconLeft={<ChevronLeft className="h-4 w-4" aria-hidden />}>
            Back
          </Button>
          {compact ? <span className="text-caption text-text-muted">{index + 1} / {slides.length}</span>
            : <SlideTabs slides={slides} index={index} onSelect={setIndex} />}
          {index === slides.length - 1 ? shareAction : (
            <Button variant="primary" className={compact ? "min-h-11" : undefined} onClick={() => go(1)}
              iconRight={<ChevronRight className="h-4 w-4" aria-hidden />}>
              Next
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
