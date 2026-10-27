"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";

type ViewportState = { isNearViewport: boolean };
type DeferredSectionProps = {
  label: string;
  minHeight?: number;
  activationRequest?: number;
  fallback?: (activate: () => void) => ReactNode;
  children: ReactNode | ((viewport: ViewportState) => ReactNode);
};

/** Admit a chart on approach or intent, then retain its controls while scrolling. */
export function DeferredSection({
  label, minHeight = 320, activationRequest = 0, fallback, children,
}: DeferredSectionProps) {
  const slot = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const visible = activated || activationRequest > 0;

  useEffect(() => { if (activationRequest > 0) setActivated(true); }, [activationRequest]);

  useEffect(() => {
    let retired = false;
    const activateFallback = () => {
      if (retired) return;
      setActivated(true);
      setIsNearViewport(true);
    };
    let observer: IntersectionObserver | undefined;
    try {
      if (typeof IntersectionObserver === "undefined") activateFallback();
      else {
        observer = new IntersectionObserver((entries) => {
          if (retired) return;
          const near = entries.some((entry) => entry.isIntersecting);
          setIsNearViewport(near);
          if (near) setActivated(true);
        }, { rootMargin: "400px 0px" });
        if (slot.current) observer.observe(slot.current);
      }
    } catch {
      observer?.disconnect();
      activateFallback();
    }
    return () => { retired = true; observer?.disconnect(); };
  }, []);

  const activate = () => { setActivated(true); setIsNearViewport(true); };
  return <div ref={slot} className="min-w-0" style={{ minHeight }} data-deferred-chart={label}>
    {visible
      ? typeof children === "function" ? children({ isNearViewport }) : children
      : fallback ? fallback(activate) : <Card title={label}>
        <div className="flex min-h-40 flex-col items-start justify-center gap-4">
          <p className="text-caption text-text-muted">This chart loads when you reach it.</p>
          <button type="button" onClick={activate} className="inline-flex min-h-11 items-center rounded-lg border border-border bg-bg-surface px-3 text-caption font-medium text-accent hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Load {label}</button>
        </div>
      </Card>}
  </div>;
}
