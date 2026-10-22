import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BuildOption } from "@/lib/buildIntent";
import { BuildPicker } from "../BuildPicker";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(cleanup);

function option(overrides: Partial<BuildOption>): BuildOption {
  return {
    key: "pvz-stargate",
    name: "PvZ - Stargate",
    slug: null,
    source: "catalog",
    games: 0,
    wins: 0,
    losses: 0,
    checkins: 0,
    lastPlayedAt: null,
    inRandomizer: false,
    group: "all",
    ...overrides,
  };
}

const OPTIONS: BuildOption[] = [
  option({
    key: "custom:dt-3-gate",
    name: "DT into 3 Gate",
    slug: "dt-3-gate",
    source: "custom",
    games: 12,
    wins: 7,
    losses: 5,
    group: "yours",
    inRandomizer: true,
  }),
  option({ key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", games: 4, wins: 1, losses: 3, group: "yours" }),
  option({ key: "pvz-blink-stalkers", name: "PvZ - Blink Stalkers" }),
  option({ key: "pvz-chargelot-archon", name: "PvZ - Chargelot Archon" }),
];

function renderPicker(props: Partial<Parameters<typeof BuildPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <BuildPicker
      options={OPTIONS}
      value={null}
      onChange={onChange}
      rolledKey="custom:dt-3-gate"
      usualKey="pvz-2-stargate-phoenix"
      {...props}
    />,
  );
  return { onChange, combobox: screen.getByRole("combobox") };
}

describe("BuildPicker", () => {
  it("groups builds into Your builds and All builds with record chips and marks", () => {
    renderPicker();
    const listbox = screen.getByRole("listbox", { name: "Build you went for" });
    const yours = within(listbox).getByRole("group", { name: "Your builds" });
    const all = within(listbox).getByRole("group", { name: "All builds" });
    expect(within(yours).getAllByRole("option").map((node) => node.getAttribute("data-build-key"))).toEqual([
      "custom:dt-3-gate",
      "pvz-2-stargate-phoenix",
    ]);
    expect(within(all).getAllByRole("option")).toHaveLength(2);

    const dt = within(yours).getAllByRole("option")[0];
    expect(within(dt).getByText("Rolled")).toBeTruthy();
    expect(within(dt).getByText("7 wins, 5 losses, 58% win rate")).toBeTruthy();
    expect(within(dt).getByText("Custom")).toBeTruthy();
    const phoenix = within(yours).getAllByRole("option")[1];
    expect(within(phoenix).getByText("Usual")).toBeTruthy();
    expect(within(phoenix).getByText("25%")).toBeTruthy();
    expect(within(all).getAllByRole("option")[0].textContent).toContain("New");
  });

  it("filters by name and announces the match count", () => {
    const { combobox } = renderPicker();
    fireEvent.change(combobox, { target: { value: "blink" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Your builds" })).toBeNull();
    expect(screen.getByText("1 build listed")).toBeTruthy();
    fireEvent.change(combobox, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No builds match “zzz”.")).toBeTruthy();
  });

  it("moves the highlight with the arrow keys and picks with Enter", () => {
    const { combobox, onChange } = renderPicker();
    const options = screen.getAllByRole("option");
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[2].id);
    fireEvent.keyDown(combobox, { key: "ArrowUp" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(OPTIONS[1]);
    fireEvent.keyDown(combobox, { key: "PageDown" });
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[3].id);
  });

  it("starts on the selected build, marks it selected and picks on click", () => {
    const { combobox, onChange } = renderPicker({
      value: "pvz-blink-stalkers",
      suggestedKey: "pvz-blink-stalkers",
    });
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.getAttribute("data-build-key")).toBe("pvz-blink-stalkers");
    expect(within(selected).getByText("Suggested")).toBeTruthy();
    expect(combobox.getAttribute("aria-activedescendant")).toBe(selected.id);
    fireEvent.click(screen.getAllByRole("option")[3]);
    expect(onChange).toHaveBeenCalledWith(OPTIONS[3]);
  });

  it("clears the search with Escape before letting the dialog close", () => {
    const { combobox } = renderPicker();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.change(combobox, { target: { value: "blink" } });
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect((combobox as HTMLInputElement).value).toBe("");
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outer);
  });

  it("shows loading, error and empty states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <BuildPicker options={undefined} loading value={null} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Loading builds")).toBeTruthy();

    rerender(
      <BuildPicker
        options={undefined}
        error="The build list couldn't load."
        onRetry={onRetry}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<BuildPicker options={[]} value={null} onChange={vi.fn()} />);
    expect(screen.getByText("No builds for this matchup yet.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Create one in your build library" }).getAttribute("href"),
    ).toBe("/builds");
  });

  it("ignores clicks while disabled", () => {
    const { onChange } = renderPicker({ disabled: true });
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
