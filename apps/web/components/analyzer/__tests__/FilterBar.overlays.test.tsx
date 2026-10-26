import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FiltersContext, defaultAnalyzerFilters, type AnalyzerFilters } from "@/lib/filterContext";
import { FilterBar } from "../FilterBar";
import { MoreFiltersPopover } from "../MoreFiltersPopover";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "owner" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, isLoading: false, error: null }) }));

let desktop = false;
beforeEach(() => {
  desktop = false;
  vi.stubGlobal("matchMedia", () => ({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function Harness({ initial = defaultAnalyzerFilters() }: { initial?: AnalyzerFilters }) {
  const [filters, setFilters] = useState(initial);
  return <FiltersContext.Provider value={{ filters, setFilters, dbRev: 0, bumpRev: () => undefined, seasons: [] }}>
    <FilterBar />
    <button>Outside filter action</button>
    <output data-testid="current-filters">{JSON.stringify(filters)}</output>
  </FiltersContext.Provider>;
}
function filters(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("current-filters").textContent || "{}");
}
function openFilters() {
  const trigger = screen.getByRole("button", { name: /^Filters/ });
  trigger.focus(); fireEvent.click(trigger);
  return trigger;
}
function dateTrigger() {
  const label = screen.getByText("Date range");
  return within(label.nextElementSibling as HTMLElement).getByRole("button");
}
function openLength() {
  const trigger = within(screen.getByRole("group", { name: "Filter by game length" })).getByRole("button", { name: "Custom" });
  trigger.focus(); fireEvent.click(trigger);
  return trigger;
}

describe("shared analyzer filter overlays", () => {
  it("dismisses the phone date picker before its Sheet and returns focus through both layers", () => {
    render(<Harness />); const trigger = openFilters();
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    const date = dateTrigger(); date.focus(); fireEvent.click(date);
    const picker = screen.getByRole("dialog", { name: "Pick a date range" });
    expect(picker.hasAttribute("aria-modal")).toBe(false);
    expect(sheet.contains(picker)).toBe(true);
    expect(date.getAttribute("aria-controls")).toBe(picker.id);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pick a date range" })).toBeNull();
    expect(document.activeElement).toBe(date);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(date, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("keeps Tab inside the Sheet while its nonmodal length picker owns Escape", () => {
    render(<Harness />); openFilters(); const trigger = openLength();
    const picker = screen.getByRole("dialog", { name: "Custom game length" });
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    const clear = within(picker).getByRole("button", { name: "Clear" });
    clear.focus(); fireEvent.keyDown(clear, { key: "Tab" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(clear);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Custom game length" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(sheet.isConnected).toBe(true);
  });

  it("keeps the desktop Filters panel open when its length child closes without locking the page", () => {
    desktop = true; render(<Harness />); const trigger = openFilters(); const custom = openLength();
    const parent = screen.getByRole("dialog", { name: "More filters" });
    const child = screen.getByRole("dialog", { name: "Custom game length" });
    expect(parent.hasAttribute("aria-modal")).toBe(false);
    expect(parent.contains(child)).toBe(true);
    expect(document.body.style.overflow).not.toBe("hidden");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(parent.isConnected).toBe(true); expect(document.activeElement).toBe(custom);
    fireEvent.keyDown(custom, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus from an outside pointer action or trap standalone desktop Tab", () => {
    vi.useFakeTimers();
    render(<><MoreFiltersPopover count={0}><button>Filter option</button></MoreFiltersPopover><button>Outside action</button></>);
    openFilters(); const done = screen.getByRole("button", { name: "Done" });
    done.focus(); expect(fireEvent.keyDown(done, { key: "Tab" })).toBe(true);
    const outside = screen.getByRole("button", { name: "Outside action" });
    fireEvent.pointerDown(outside); outside.focus(); act(() => { vi.runAllTimers(); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(outside);
  });

  it("discards uncommitted length drafts on reopen and applies normalized bounds immediately", () => {
    render(<Harness />); openFilters(); const trigger = openLength();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Min (min)" }), { target: { value: "25" } });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(filters().min_minutes).toBeUndefined();
    fireEvent.click(trigger);
    expect((screen.getByRole("spinbutton", { name: "Min (min)" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Min (min)" }), { target: { value: "25" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Max (min)" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(filters().min_minutes).toBe(12); expect(filters().max_minutes).toBe(25);
    expect(screen.queryByRole("dialog", { name: "Custom game length" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("retains date drafts on dismissal and still includes the full custom end day", () => {
    render(<Harness />); openFilters(); const trigger = dateTrigger(); fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-10-07" } });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); fireEvent.click(trigger);
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-10-01");
    fireEvent.click(screen.getByRole("button", { name: "Apply custom range" }));
    expect(filters().preset).toBe("custom");
    const end = new Date(filters().until!);
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()])
      .toEqual([2026, 9, 7, 23, 59, 59, 999]);
  });

  it("releases the Sheet lock without focusing detached content when parent and picker unmount together", () => {
    const { unmount } = render(<Harness />);
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ })); openLength();
    unmount();
    // The captured Sheet trigger was removed too, so never focus detached content.
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement?.isConnected).toBe(true); outside.remove();
  });
});
