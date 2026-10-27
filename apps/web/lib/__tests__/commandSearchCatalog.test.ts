import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_ENTRIES } from "@/components/chrome/appNav";
import { BUILD_DEFINITIONS } from "../build-definitions";
import { GLOSSARY } from "../glossary";
import { ALL_HELP_ARTICLES } from "../help/articles/index.generated";
import { SETTINGS_FIELDS } from "../settingsIndex";
import { WIDGET_GUIDES } from "../streamStudioLearn";
import { createCommandCatalog, type CommandCatalogOptions } from "../commandSearchCatalog";
import { isCommandSearchHref, searchCommands } from "../commandSearch";

const signedOut: CommandCatalogOptions = { navigation: [], settingsTabs: [], signedIn: false };
afterEach(() => vi.unstubAllGlobals());

describe("lazy public command catalog projection", () => {
  it("uses precisely the caller's admitted navigation and strips unrelated data", () => {
    const admitted = NAV_ENTRIES.filter(entry => ["today", "guides"].includes(entry.key));
    const navigation = admitted.map(entry => ({ ...entry, privateNote: "DO NOT INDEX ME" }));
    const rows = createCommandCatalog({ ...signedOut, navigation }).filter(row => row.group === "navigation");
    expect(rows.map(row => row.id)).toEqual(admitted.map(entry => `navigation:${entry.key}`));
    expect(rows.map(row => row.description)).toEqual(admitted.map(entry => entry.description));
    expect(rows.some(row => row.href === "/admin" || row.href === "/coaching")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("DO NOT INDEX ME");
    expect(rows.every(row => !("icon" in row))).toBe(true);
  });

  it("omits Settings when availability is unknown or the visitor is signed out", () => {
    expect(createCommandCatalog({ ...signedOut, signedIn: true }).some(row => row.group === "settings")).toBe(false);
    const visitor = createCommandCatalog({ ...signedOut, settingsTabs: ["chat", "profile"] });
    expect(visitor.some(row => row.group === "settings")).toBe(false);
    expect(visitor.some(row => row.href === "/devices" || row.action === "pair-device")).toBe(false);
  });

  it("exposes only available Settings fields and preserves their canonical section hrefs", () => {
    const catalog = createCommandCatalog({ ...signedOut, signedIn: true, settingsTabs: ["chat"] });
    const fields = catalog.filter(row => row.group === "settings");
    expect(fields).toHaveLength(SETTINGS_FIELDS.filter(field => field.tab === "chat").length);
    expect(fields.every(row => row.href?.startsWith("/settings?tab=chat#"))).toBe(true);
    const matches = searchCommands(catalog, "TTS volume", ["settings"]).flatMap(group => group.items);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: "settings:chat-tts", href: "/settings?tab=chat#tts" });
  });
});

describe("public catalog boundaries", () => {
  it("projects actual Help/glossary/definition/widget catalogs without private values or previews", () => {
    const catalog = createCommandCatalog(signedOut);
    expect(catalog.filter(row => row.group === "help")).toHaveLength(ALL_HELP_ARTICLES.length);
    expect(catalog.filter(row => row.group === "glossary")).toHaveLength(GLOSSARY.length);
    expect(catalog.filter(row => row.group === "definitions")).toHaveLength(BUILD_DEFINITIONS.length);
    expect(catalog.filter(row => row.group === "widgets")).toHaveLength(WIDGET_GUIDES.length);
    expect(catalog.find(row => row.id === "glossary:session")?.href).toBe("/help/sessions#definition");
    expect(catalog.filter(row => row.group === "widgets").every(row =>
      row.href?.startsWith("/stream-studio/learn?widget=") && row.href.endsWith("#widget-library"))).toBe(true);
    expect(catalog.some(row => row.href?.startsWith("/overlay/") || row.href?.startsWith("/dock/"))).toBe(false);
    expect(catalog.every(row => !("body" in row) && !("example" in row) && !("settingsHref" in row))).toBe(true);
  });

  it("returns unique stable keys, internal links and a closed set of known actions", () => {
    const catalog = createCommandCatalog({ ...signedOut, signedIn: true });
    expect(new Set(catalog.map(row => row.id)).size).toBe(catalog.length);
    for (const row of catalog) if (row.href) expect(isCommandSearchHref(row.href)).toBe(true);
    expect(catalog.flatMap(row => row.action ? [row.action] : []).sort()).toEqual([
      "pair-device", "report-problem", "shortcuts", "toggle-theme", "whats-new",
    ]);
    expect(catalog.find(row => row.id === "action:download")?.href).toBe("/download");
  });

  it("does not perform requests while constructing or querying the catalog", () => {
    const fetch = vi.fn(() => { throw new Error("No command catalog requests are permitted"); });
    vi.stubGlobal("fetch", fetch);
    const catalog = createCommandCatalog(signedOut);
    searchCommands(catalog, "pair device");
    searchCommands(catalog, "chrono");
    expect(fetch).not.toHaveBeenCalled();
  });
});
