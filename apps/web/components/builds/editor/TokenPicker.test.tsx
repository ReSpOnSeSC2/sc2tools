import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenPicker } from "./TokenPicker";
afterEach(cleanup);
function Harness({ race = "Protoss", initial = "BuildStargate", spy = vi.fn() }: { race?: string; initial?: string; spy?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <><TokenPicker value={value} race={race} onChange={next => { spy(next); setValue(next); }} /><button type="button">Outside field</button></>;
}
describe("TokenPicker in a rule draft", () => {
  it("shows friendly labels and stores the chosen exact action token", () => {
    const spy = vi.fn(); render(<Harness spy={spy} />); const input = screen.getByRole("combobox"); expect((input as HTMLInputElement).value).toBe("Stargate");
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Gateway" } }); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith("BuildGateway"); expect((input as HTMLInputElement).value).toBe("Gateway");
    act(() => screen.getByRole("button", { name: "Outside field" }).focus());
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option").some(row => row.textContent?.includes("BuildStargate"))).toBe(true);
  });
  it.each(["Escape", "Tab", "outside"])("keeps an unknown partial draft filtered after %s and reopening", (closeBy) => {
    render(<Harness initial="BuildMissing" />); const input = screen.getByRole("combobox");
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Gatew" } });
    expect(input.getAttribute("aria-invalid")).toBe("true"); expect(screen.getAllByRole("option")).toHaveLength(1);
    if (closeBy === "outside") fireEvent.pointerDown(screen.getByRole("button", { name: "Outside field" }));
    else fireEvent.keyDown(input, { key: closeBy });
    expect(screen.queryByRole("listbox")).toBeNull(); expect((input as HTMLInputElement).value).toBe("Gatew");
    const outside = screen.getByRole("button", { name: "Outside field" });
    act(() => outside.focus()); expect(document.activeElement).toBe(outside);
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(1); expect(screen.getByRole("option").textContent).toContain("BuildGateway");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("filters by race, surfaces proxy eligibility and retains unknown text for correction", () => {
    render(<Harness race="Terran" initial="BuildMissing" />); const input = screen.getByRole("combobox"); expect(input.getAttribute("aria-invalid")).toBe("true"); expect(screen.getByText(/Unknown action/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Stargate" } }); expect(screen.queryByRole("option")).toBeNull();
    fireEvent.change(input, { target: { value: "Barracks" } }); expect(screen.getAllByRole("option").some(row => row.textContent?.includes("Proxy eligible"))).toBe(true);
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
