import { ChatCommandsCard } from "@/components/analyzer/settings/ChatCommandsCard";
import type { HelpWidgetId } from "@/lib/help/types";

/**
 * Interactive pieces an article can embed with `{ type: "widget" }`.
 * Each id also has searchable text in lib/help/widgets.ts.
 */
export function HelpWidget({ widget }: { widget: HelpWidgetId }) {
  switch (widget) {
    case "chat-commands":
      // Help shows the default rank theme; the copy in Settings → Overlay
      // uses the streamer's saved race.
      return <ChatCommandsCard rankRace="protoss" />;
  }
}
