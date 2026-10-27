import { COMMAND_GROUPS } from "@/lib/multichat/commandsGuide";
import { GLOSSARY } from "@/lib/glossary";
import type { HelpWidgetId } from "./types";

/**
 * Searchable text for each embeddable help widget, so a reader who
 * types "!rank" finds the article that embeds the commands card. The
 * components themselves live in components/help/HelpWidget.tsx.
 */
const WIDGET_TEXT: Record<HelpWidgetId, () => string> = {
  "guided-tours": () => "Take a tour. Replay the Today, game breakdown and Overlay settings walkthroughs. Next, Back, Skip and saved tour progress.",
  glossary: () => GLOSSARY.flatMap(term => [term.term, term.short, term.long ?? "", term.formula ?? ""]).join(" "),
  "chat-commands": () =>
    COMMAND_GROUPS.flatMap((group) => [
      group.title,
      group.intro,
      ...group.commands.flatMap((command) => [command.syntax, command.aliases ?? "", command.description]),
    ])
      .filter(Boolean)
      .join(" "),
};

/** Every widget id an article may embed. */
export const HELP_WIDGET_IDS = Object.keys(WIDGET_TEXT) as HelpWidgetId[];

/**
 * Plain text for a widget's content.
 *
 * Example: `helpWidgetText("chat-commands")` → "Predictions While my next game … !win !w …".
 */
export function helpWidgetText(id: HelpWidgetId): string {
  return WIDGET_TEXT[id]();
}

/** Published glossary links remain known to the existing Help anchor API. */
export function helpWidgetAnchors(id: HelpWidgetId): string[] {
  return id === "glossary" ? GLOSSARY.map(term => term.id) : [];
}
