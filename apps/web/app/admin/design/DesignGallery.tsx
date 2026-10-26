"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ToastProvider } from "@/components/ui/Toast";
import { ControlSamples } from "./ControlSamples";
import { OverlaySamples } from "./OverlaySamples";
import { StateSamples } from "./StateSamples";

/** Synthetic, local-only examples: no replay reads or API writes. */
export function DesignGallery() {
  return <ToastProvider><div className="space-y-8" data-testid="design-gallery">
    <PageHeader title="Design gallery" eyebrow="Admin · Component reference"
      description="Try the shared controls with your keyboard and at narrow widths. All values are examples; sample data stays local to this page."
      actions={<div className="flex items-center gap-2"><span className="text-caption text-text-muted">Preview light and dark</span><ThemeToggle className="min-h-11 min-w-11" /></div>} />
    <nav aria-label="Gallery examples" className="flex flex-wrap gap-x-5 gap-y-3 text-caption">
      {[ ["controls", "Controls"], ["overlays", "Dialogs and overlays"], ["states", "Content and states"] ].map(([id, label]) =>
        <a key={id} href={`#gallery-${id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}</a>)}
    </nav>
    <Section id="gallery-controls" title="Controls" description="Button variants, input validation and keyboard selection."><ControlSamples /></Section>
    <Section id="gallery-overlays" title="Dialogs and overlays" description="Tab stays inside modal dialogs. Escape closes the top overlay and returns focus; nonmodal popovers let Tab continue."><OverlaySamples /></Section>
    <Section id="gallery-states" title="Content and states" description="Loading, empty and unavailable examples are labeled so they cannot be mistaken for recorded results."><StateSamples /></Section>
  </div></ToastProvider>;
}
