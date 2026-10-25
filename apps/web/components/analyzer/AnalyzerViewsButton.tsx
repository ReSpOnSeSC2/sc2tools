"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const AnalyzerViewsDialog = dynamic(() => import("./AnalyzerViewsDialog").then(module => module.AnalyzerViewsDialog), { ssr: false });

export function AnalyzerViewsButton() {
  const [open, setOpen] = useState(false);
  return <><button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="min-h-11 rounded-full border border-border px-3 text-caption font-semibold text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Views</button>{open ? <AnalyzerViewsDialog onClose={() => setOpen(false)} /> : null}</>;
}
