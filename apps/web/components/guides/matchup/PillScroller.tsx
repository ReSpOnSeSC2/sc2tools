"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function PillScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    setMore(Boolean(el && el.scrollWidth > el.clientWidth + el.scrollLeft + 2));
  }, []);
  useEffect(() => {
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);
  return <ul ref={ref} onScroll={measure} className={`flex min-w-0 max-w-full flex-nowrap gap-1.5 overflow-x-auto snap-x pb-1 sm:flex-wrap ${more ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]" : ""}`}>{children}</ul>;
}
