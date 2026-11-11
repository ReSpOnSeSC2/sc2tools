"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { OverlayLayoutEditor } from "./OverlayLayoutEditor";

const LayoutEditor = dynamic(() => import("./OverlayLayoutEditor").then(module => module.OverlayLayoutEditor), {
  ssr: false, loading: () => <p role="status" className="text-caption text-text-muted">Loading canvas…</p>,
});

export function LazyOverlayLayout(props: ComponentProps<typeof OverlayLayoutEditor>) {
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      if (window.location.hash === "#layout" && details.current) details.current.open = true;
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  return <details id="layout" ref={details} className="mt-4 scroll-mt-28 rounded-lg border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="flex min-h-11 cursor-pointer items-center text-body font-semibold text-text">Arrange widgets</summary>
    {open ? <LayoutEditor {...props} /> : null}
  </details>;
}
