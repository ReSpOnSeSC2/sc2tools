"use client";

import dynamic from "next/dynamic";
import { ChatCommandsCard } from "@/components/analyzer/settings/ChatCommandsCard";
import type { HelpWidgetId } from "@/lib/help/types";

// Keep the searchable catalog with its widget, while retaining public SSR.
const GlossaryBrowser = dynamic(() => import("./GlossaryBrowser").then(module => module.GlossaryBrowser), { ssr: true });
const TakeATour = dynamic(() => import("./TakeATour").then(module => module.TakeATour), { ssr: true });

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
