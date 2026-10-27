import type { NavEntry } from "@/components/chrome/appNav";
import { BUILD_DEFINITIONS, definitionHref } from "./build-definitions";
import { GLOSSARY, glossaryHelpPath } from "./glossary";
import { ALL_HELP_ARTICLES } from "./help/articles/index.generated";
import { helpArticlePath } from "./help/paths";
import { SETTINGS_FIELDS, settingsFieldHref } from "./settingsIndex";
import type { SettingsTabId } from "./settingsRegistry";
import { WIDGET_GUIDES } from "./streamStudioLearn";
import { isCommandSearchHref, type CommandSearchItem } from "./commandSearch";

/** Public catalogs only. Import this data leaf only inside the lazy palette. */
export type CommandCatalogOptions = {
  navigation: readonly Pick<NavEntry, "key" | "href" | "label" | "description">[];
  settingsTabs: readonly SettingsTabId[];
  signedIn: boolean;
};

function navigationItems(options: CommandCatalogOptions): CommandSearchItem[] {
  return options.navigation.filter(entry => isCommandSearchHref(entry.href)).map(entry => ({
    id: `navigation:${entry.key}`, group: "navigation", label: entry.label,
    description: entry.description, href: entry.href,
  }));
}

function settingsItems(options: CommandCatalogOptions): CommandSearchItem[] {
  if (!options.signedIn) return [];
  const allowed = new Set(options.settingsTabs);
  return SETTINGS_FIELDS.filter(field => allowed.has(field.tab)).map(field => ({
    id: `settings:${field.id}`, group: "settings", label: field.label,
    terms: field.synonyms, href: settingsFieldHref(field),
  }));
}

function helpItems(): CommandSearchItem[] {
  return ALL_HELP_ARTICLES.map(article => ({
    id: `help:${article.slug}`, group: "help", label: article.title,
    description: article.summary, terms: article.keywords, href: helpArticlePath(article.slug),
  }));
}

function glossaryItems(): CommandSearchItem[] {
  return GLOSSARY.map(term => ({
    id: `glossary:${term.id}`, group: "glossary", label: term.term,
    description: term.short, terms: [term.category], href: glossaryHelpPath(term),
  }));
}

function definitionItems(): CommandSearchItem[] {
  return BUILD_DEFINITIONS.flatMap(definition => {
    const href = definitionHref(definition.name);
    return href ? [{
      id: `definition:${definition.id}`, group: "definitions" as const, label: definition.name,
      description: definition.description, terms: [definition.eightWorkerName ?? ""], href,
    }] : [];
  });
}

function widgetItems(): CommandSearchItem[] {
  return WIDGET_GUIDES.map(widget => ({
    id: `widget:${widget.id}`, group: "widgets", label: widget.name,
    description: widget.summary, terms: [widget.group],
    href: `/stream-studio/learn?widget=${encodeURIComponent(widget.id)}#widget-library`,
  }));
}

function actionItems(signedIn: boolean): CommandSearchItem[] {
  const common: CommandSearchItem[] = [
    { id: "action:download", group: "actions", label: "Download the desktop app", href: "/download" },
    { id: "action:report", group: "actions", label: "Report a problem", action: "report-problem" },
    { id: "action:news", group: "actions", label: "What's new", action: "whats-new" },
    { id: "action:theme", group: "actions", label: "Change appearance", terms: ["toggle theme"],
      action: "toggle-theme" },
    { id: "action:shortcuts", group: "actions", label: "Keyboard shortcuts", action: "shortcuts" },
  ];
  return signedIn ? [
    ...common,
    { id: "action:devices", group: "actions", label: "Open Devices", href: "/devices" },
    { id: "action:pair", group: "actions", label: "Pair a device", action: "pair-device" },
  ] : common;
}

/** Projects public labels and caller-admitted routes.
 * Example: createCommandCatalog({ navigation, settingsTabs, signedIn }). */
export function createCommandCatalog(options: CommandCatalogOptions): CommandSearchItem[] {
  return [
    ...navigationItems(options), ...settingsItems(options), ...helpItems(), ...glossaryItems(),
    ...definitionItems(), ...widgetItems(), ...actionItems(options.signedIn),
  ];
}
