import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandGuideCatalog } from "@/lib/commandGuideSearch";
import { CommandPalette, type CommandPalettePrivateState, type CommandPaletteProps } from "../CommandPalette";
import { COMMAND_SEARCH_GROUPS } from "@/lib/commandSearch";
import { decodePrivateCommandSearch, privateCommandChoices } from "@/lib/privateCommandSearch";

const defaults: CommandPaletteProps = {
  navigation: [], settingsTabs: ["chat"], signedIn: true, guideItems: [], guidesStatus: "ready",
  onRetryGuides: () => {}, onClose: () => {}, onSelect: () => {},
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ props }: { props: CommandPaletteProps }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open search</button>
    {open ? <CommandPalette {...props} onClose={() => { props.onClose(); setOpen(false); }}
      onSelect={item => { props.onSelect(item); setOpen(false); }} /> : null}</>;
}

async function open(props: Partial<CommandPaletteProps> = {}) {
  const view = render(<Harness props={{ ...defaults, ...props }} />);
  const trigger = screen.getByRole("button", { name: "Open search" });
  trigger.focus(); fireEvent.click(trigger);
  const input = screen.getByRole("combobox");
  await waitFor(() => expect(document.activeElement).toBe(input));
  return { ...view, input, trigger };
}

describe("actual palette and Modal keyboard consumer", () => {
  it("selects a real Settings synonym once and returns focus through the real Modal", async () => {
    const select = vi.fn(), close = vi.fn();
    const { input, trigger } = await open({ onSelect: select, onClose: close });
    fireEvent.change(input, { target: { value: "TTS volume" } });
    const option = screen.getByRole("option");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(option.getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toMatchObject({ href: "/settings?tab=chat#tts" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("lets Modal close once on the first Escape while results are open", async () => {
    const close = vi.fn(), select = vi.fn();
    const { input, trigger } = await open({ onClose: close, onSelect: select, initialQuery: "TTS" });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

function personal(count = 1): CommandPalettePrivateState {
  const data = decodePrivateCommandSearch({ version: 2, groups: {
    opponents: { status: "ready", hasMore: count === 8, items: Array.from({ length: count }, (_, index) => ({
      pulseId: `id${index}`, displayNameSample: `Unrelated private opponent ${index}`, race: null, lastSeen: null,
    })) },
    customBuilds: { status: "ready", hasMore: false, items: Array.from({ length: count }, (_, index) => ({
      slug: `build${index}`, name: `Unrelated private build ${index}`, race: null, vsRace: null, perspective: null, updatedAt: null,
    })) },
    maps: { status: "ready", hasMore: false, items: Array.from({ length: count }, (_, index) => ({ map: `Map ${index}` })) },
  } });
  return { phase: "ready", validQuery: true, data, choices: privateCommandChoices(data), onRetry: vi.fn(), onSelect: vi.fn(() => true) };
}

describe("private groups remain literal, distinct and bounded", () => {
  it("keeps the active opponent identity through same-query Retry and a changed server order", async () => {
    const base = personal(2), select = vi.fn(() => true);
    const first = decodePrivateCommandSearch({ version: 2, groups: { ...base.data!.groups,
      maps: { status: "unavailable", items: [], hasMore: null, reason: "busy" } } });
    const reordered = decodePrivateCommandSearch({ version: 2, groups: { ...first.groups, opponents: {
      status: "ready", hasMore: false, items: [
        { ...first.groups.opponents.items[1], lastSeen: "2026-10-27T12:00:00.000Z" },
        { ...first.groups.opponents.items[0], lastSeen: null },
      ],
    } } });
    const next = { ...base, data: reordered, choices: privateCommandChoices(reordered), onSelect: select };
    function RetryHarness() {
      const [state, setState] = useState({ ...base, data: first, choices: privateCommandChoices(first), onSelect: select });
      return <CommandPalette {...defaults} initialQuery="unmatched-public-word"
        privateSearch={{ ...state, onRetry: () => setState(next) }} />;
    }
    render(<RetryHarness />);
    const input = screen.getByRole("combobox", { name: "Search" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "ArrowDown" });
    const chosen = screen.getByRole("option", { name: "Unrelated private opponent 1" }), activeId = chosen.id;
    expect(input.getAttribute("aria-activedescendant")).toBe(activeId);
    fireEvent.click(screen.getByRole("button", { name: "Retry your library search" }));
    expect(screen.getByRole("option", { name: "Unrelated private opponent 1" })).toBe(chosen);
    expect(input.getAttribute("aria-activedescendant")).toBe(activeId);
    expect((input as HTMLInputElement).value).toBe("unmatched-public-word");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith(next.choices[0]);
    expect(next.choices[0].target).toEqual({ kind: "opponent", pulseId: "id1" });
  });
  it("shows deferred maps as a lasting state, without a library failure or Retry", async () => {
    const base = personal(1);
    const data = decodePrivateCommandSearch({ version: 2, groups: { ...base.data!.groups,
      maps: { status: "unavailable", items: [], hasMore: null, reason: "deferred" } } });
    render(<CommandPalette {...defaults} initialQuery="unrelated" privateSearch={{ ...base, data, choices: privateCommandChoices(data) }} />);
    expect(await screen.findByText("Not in quick search yet. Open the full library to browse it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry your library search" })).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("Some library results are unavailable.");
  });
  it("keeps all server rows in server order without public query scoring", async () => {
    const state = personal(8), select = vi.fn();
    const { input } = await open({ initialQuery: "no-public-match-at-all", privateSearch: state, onSelect: select });
    const own = screen.getByRole("group", { name: "Your opponents" });
    expect(Array.from(own.querySelectorAll('[role="option"]')).map(option => option.textContent)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Unrelated private opponent ${index}`));
    expect(screen.getByText("More matches are available in the full library.")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Unrelated private opponent 0" }));
    expect(state.onSelect).toHaveBeenCalledWith(state.choices[0]); expect(select).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
  it("reserves all24 private rows plus library actions within the existing total60", async () => {
    const guideItems = COMMAND_SEARCH_GROUPS.flatMap((group, groupIndex) => Array.from({ length: 8 }, (_, index) => ({
      id: `cap:${group.id}:${index}`, group: group.id, label: `Capquery ${groupIndex} ${index}`, href: `/help/cap-${groupIndex}-${index}`,
    })));
    await open({ initialQuery: "Capquery", guideItems, privateSearch: personal(8) });
    expect(screen.getAllByRole("option")).toHaveLength(60);
    for (const name of ["Your opponents", "Your builds", "Your maps"]) {
      expect(screen.getByRole("group", { name }).querySelectorAll('[role="option"]')).toHaveLength(8);
    }
    expect(screen.getByRole("group", { name: "Your library" }).querySelectorAll('[role="option"]')).toHaveLength(3);
  });
  it("never reports false no matches when maps are deferred and nothing else matches", async () => {
    const data = decodePrivateCommandSearch({ version: 2, groups: {
      opponents: { status: "ready", items: [], hasMore: false },
      customBuilds: { status: "ready", items: [], hasMore: false },
      maps: { status: "unavailable", items: [], hasMore: null, reason: "deferred" },
    } });
    await open({ initialQuery: "unknown-public-term", privateSearch: { ...personal(), data, choices: privateCommandChoices(data) } });
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("No public matches.");
    expect(status).not.toContain("No matching results");
    expect(status).not.toContain("Some library results are unavailable.");
    expect(screen.queryByRole("button", { name: "Retry your library search" })).toBeNull();
  });
  it("announces unavailable groups and explicit retry/library actions rather than false no matches", async () => {
    const data = decodePrivateCommandSearch({ version: 2, groups: {
      opponents: { status: "unavailable", items: [], hasMore: null, reason: "retired" },
      customBuilds: { status: "ready", items: [], hasMore: false },
      maps: { status: "unavailable", items: [], hasMore: null, reason: "source_budget_exceeded" },
    } });
    const state = { ...personal(), data, choices: privateCommandChoices(data) };
    await open({ initialQuery: "unknown-public-term", privateSearch: state });
    expect(screen.getByRole("status").textContent).not.toContain("No matching results");
    expect(screen.getByText("This library changed during search. Search again.")).toBeTruthy();
    expect(screen.getByText("This library is too large for quick search.")).toBeTruthy();
    expect(screen.getByText("No matching saved builds.")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Open Maps" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry your library search" })); expect(state.onRetry).toHaveBeenCalledOnce();
  });
  it.each(["short", "pending"])("uses an honest %s prompt and keeps pure presentation off the network", async kind => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const state: CommandPalettePrivateState = { ...personal(), data: null, choices: [],
      validQuery: kind !== "short", phase: kind === "short" ? "idle" : "loading" };
    await open({ initialQuery: kind === "short" ? "x" : "unlikely-public-token", privateSearch: state });
    const status = screen.getByRole("status").textContent;
    expect(status).toContain(kind === "short" ? "at least 2 valid characters" : "Searching your library");
    expect(status).not.toContain("No matching results"); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not expose personal groups/actions in a Guides-only or signed-out palette", async () => {
    const view = await open({ scope: "guides", privateSearch: personal(), initialQuery: "private" });
    expect(screen.queryByRole("group", { name: "Your library" })).toBeNull();
    view.unmount(); await open({ signedIn: false, privateSearch: personal(), initialQuery: "private" });
    expect(screen.queryByRole("group", { name: "Your opponents" })).toBeNull();
  });
});

describe("palette result focus and publication", () => {
  it("uses stable active IDs, retains input focus and never announces every arrow", async () => {
    const navigation = [
      { key: "alpha", label: "Onlypalette Alpha", href: "/app" },
      { key: "beta", label: "Onlypalette Beta", href: "/download" },
    ];
    const { input } = await open({ navigation, initialQuery: "Onlypalette" });
    const options = screen.getAllByRole("option"), status = screen.getByRole("status").textContent;
    expect(fireEvent.keyDown(input, { key: "Home" })).toBe(true);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(input, { key: "End" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("status").textContent).toBe(status);
    expect(options.every(option => option.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("keeps unavailable catalog matches unlinked and skips them for Enter/pointer selection", async () => {
    const select = vi.fn();
    const guideItems = createCommandGuideCatalog({ publishedPaths: null });
    const { input } = await open({ guideItems, scope: "guides", guidesStatus: "unavailable",
      initialQuery: "12 pool pvz", onSelect: select });
    const options = screen.getAllByRole("option");
    expect(options.every(option => option.getAttribute("aria-disabled") === "true")).toBe(true);
    // Unlinked rows stay listed but greyed; each carries its matchup as a badge.
    const pool = options.find(option => option.textContent?.startsWith("12 Pool"))!;
    expect(within(pool).getByText("12 Pool").className).toContain("text-text-muted");
    expect(within(pool).getByText("PvZ").className).toContain("min-h-5");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.pointerDown(options[0]); fireEvent.click(options[0]);
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("chooses the positively published counter while skipping other disabled results", async () => {
    const select = vi.fn(), path = "/guides/pvz/counter/12-pool";
    const guideItems = createCommandGuideCatalog({ publishedPaths: new Set([path]) });
    const { input } = await open({ guideItems, scope: "guides", initialQuery: "12pool pvz", onSelect: select });
    const enabled = screen.getAllByRole("option").filter(option => option.getAttribute("aria-disabled") !== "true");
    expect(enabled).toHaveLength(1);
    expect(within(enabled[0]).getByText("12 Pool").className).not.toContain("text-text-muted");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(enabled[0].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toMatchObject({ href: path, matchup: "PvZ", disabled: false });
  });
});

describe("palette status and ephemeral state", () => {
  it("keeps options out of Tab order and inherits Modal's first/last focus wrap", async () => {
    await open();
    const footer = screen.getByRole("button", { name: "Keyboard shortcuts" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(screen.getAllByRole("option").every(option => option.tabIndex === -1)).toBe(true);
    footer.focus(); fireEvent.keyDown(footer, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(footer);
  });

  it("exposes retry as an explicit callback and preserves the typed query", async () => {
    const retry = vi.fn();
    const { input } = await open({ scope: "guides", guidesStatus: "unavailable", onRetryGuides: retry });
    fireEvent.change(input, { target: { value: "no-such-guide-xyz" } });
    expect(screen.getByRole("status").textContent).toContain("No matching results");
    fireEvent.click(screen.getByRole("button", { name: "Retry guide availability" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe("no-such-guide-xyz");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not keep the previous opening's query and routes the footer action through onSelect", async () => {
    const select = vi.fn();
    const { input, trigger } = await open({ onSelect: select });
    fireEvent.change(input, { target: { value: "private query" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(trigger);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toMatchObject({ action: "shortcuts" });
  });

  it("does not request data or store queries during real input and result interaction", async () => {
    const fetch = vi.fn(), storage = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("fetch", fetch);
    try {
      const { input } = await open();
      fireEvent.change(input, { target: { value: "TTS volume" } });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); }
  });
});
