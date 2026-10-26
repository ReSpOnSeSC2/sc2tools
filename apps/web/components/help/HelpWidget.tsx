import { ChatCommandsCard } from "@/components/analyzer/settings/ChatCommandsCard";
import type { HelpWidgetId } from "@/lib/help/types";
import { GlossaryBrowser } from "./GlossaryBrowser";

/**
 * Interactive pieces an article can embed with `{ type: "widget" }`.
 * Each id also has searchable text in lib/help/widgets.ts.
 */
export function HelpWidget({ widget, variant = "page" }: { widget: HelpWidgetId; variant?: "page" | "compact" }) {
  switch (widget) {
    case "glossary":
      return <GlossaryBrowser variant={variant} />;
    case "chat-commands":
      // Help shows the default rank theme; the copy in Settings → Overlay
      // uses the streamer's saved race.
      return <ChatCommandsCard rankRace="protoss" />;
  }
}
