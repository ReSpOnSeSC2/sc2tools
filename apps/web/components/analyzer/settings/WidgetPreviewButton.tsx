"use client";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { LazyWidgetPlayground } from "@/components/stream-studio/LazyWidgetPlayground";
export function WidgetPreviewButton({ widget, name }: { widget: string; name: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} aria-label={`Preview ${name} locally`} className="inline-flex min-h-11 items-center rounded border border-border px-3 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Preview</button><Modal open={open} onClose={() => setOpen(false)} title={`${name} playground`} description="Sample data only. Nothing is sent to OBS." size="3xl" mobileLayout="center">{open ? <LazyWidgetPlayground initialWidget={widget} compact autoLoad /> : null}</Modal></>;
}
