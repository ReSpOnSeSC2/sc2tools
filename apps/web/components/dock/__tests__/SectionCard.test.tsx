import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useDockLayout } from "../useDockLayout";
import { SectionCard } from "../SectionCard";
import { orderedDockSections, DOCK_LAYOUT_KEY } from "@/lib/dockLayout";

function Fixture() {
  const { layout, setOpen, togglePin, reset } = useDockLayout();
  return <><button onClick={reset}>Reset layout</button><div data-testid="sections">{orderedDockSections(layout).map(id => <SectionCard key={id} id={id} title={id === "dock-poll" ? "Poll" : id} summary="open · 34 votes" active open={!layout.collapsed.includes(id)} pinned={layout.pinned.includes(id)} onToggle={() => setOpen(id, layout.collapsed.includes(id))} onPin={() => togglePin(id)}>
    <input aria-label={`Draft ${id}`} defaultValue="" />
  </SectionCard>)}</div></>;
}
afterEach(() => { cleanup(); localStorage.clear(); });
describe("Dock section disclosure and browser layout", () => {
  it("folds a real draft without losing it and restores the saved disclosure on remount", () => {
    const view = render(<Fixture />); fireEvent.change(screen.getByLabelText("Draft dock-poll"), { target: { value: "My next poll" } });
    const toggle = screen.getByRole("button", { name: "Poll" }); fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(toggle.getAttribute("aria-controls")).toBe("dock-poll-body");
    expect(toggle.textContent).toContain("open · 34 votes"); expect(screen.queryByRole("textbox", { name: "Draft dock-poll" })).toBeNull();
    fireEvent.click(toggle); expect((screen.getByLabelText("Draft dock-poll") as HTMLInputElement).value).toBe("My next poll");
    fireEvent.click(toggle); view.unmount(); render(<Fixture />);
    expect(screen.getByRole("button", { name: /Poll · open/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("pins to the top without toggling or remounting its draft, then Reset restores defaults", () => {
    render(<Fixture />); fireEvent.change(screen.getByLabelText("Draft dock-poll"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin Poll to top" }));
    expect(screen.getByTestId("sections").firstElementChild?.id).toBe("dock-poll");
    expect((screen.getByLabelText("Draft dock-poll") as HTMLInputElement).value).toBe("Keep this draft");
    expect(screen.getByRole("button", { name: "Poll" }).getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY)!)).toMatchObject({ pinned: ["dock-poll"] });
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.getByTestId("sections").firstElementChild?.id).toBe("dock-chat");
    expect((screen.getByLabelText("Draft dock-poll") as HTMLInputElement).value).toBe("Keep this draft");
    expect(screen.getByRole("button", { name: "Pin Poll to top" }).closest("button")?.querySelector("button")).toBeNull();
  });
});
