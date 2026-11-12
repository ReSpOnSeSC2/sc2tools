"use client";

import dynamic from "next/dynamic";
import type { HelpWidgetId } from "@/lib/help/types";

// Load each widget on its own article and retain its public server render.
const GlossaryBrowser = dynamic(() => import("./GlossaryBrowser").then(module => module.GlossaryBrowser), { ssr: true });
const TakeATour = dynamic(() => import("./TakeATour").then(module => module.TakeATour), { ssr: true });
const ChatCommandsCard = dynamic(
  () => import("@/components/analyzer/settings/ChatCommandsCard").then(module => module.ChatCommandsCard),
  { ssr: true, loading: () => <p role="status" className="text-caption text-text-muted">Loading chat commands…</p> },
);

/**
 * Interactive pieces an article can embed with `{ type: "widget" }`.
 * Each id also has searchable text in lib/help/widgets.ts.
 */
export function HelpWidget({ widget, variant = "page" }: { widget: HelpWidgetId; variant?: "page" | "compact" }) {
  switch (widget) {
    case "guided-tours":
      return <TakeATour />;
    case "glossary":
      return <GlossaryBrowser variant={variant} />;
    case "chat-commands":
      // Help shows the default rank theme; the copy in Settings → Overlay
      // uses the streamer's saved race.
      return <ChatCommandsCard rankRace="protoss" />;
  }
}
