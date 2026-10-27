import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandGuideCatalog } from "@/lib/commandGuideSearch";
import { CommandPalette, type CommandPaletteProps } from "../CommandPalette";

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
