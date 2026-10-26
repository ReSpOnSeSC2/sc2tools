import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "../Combobox";
import { Modal } from "../Modal";
const options: ComboboxOption[] = [
  { value: "BuildGateway", label: "Gateway", description: "Protoss building", searchTerms: ["production"] },
  { value: "BuildPylon", label: "Pylon", disabled: true },
  { value: "BuildStargate", label: "Stargate", icon: <span>icon</span> },
];
function Harness({ spy = vi.fn() }: { spy?: (value: string) => void }) {
  const [value, setValue] = useState("BuildGateway");
  return <><Combobox label="Build action" value={value} options={options} onChange={next => { spy(next); setValue(next); }} /><button type="button">Next field</button></>;
}
function DraftHarness({ spy = vi.fn(), selectValue = false }: { spy?: (value: string) => void; selectValue?: boolean }) {
  const [value, setValue] = useState("");
  return <><Combobox label="Find field" value={value} options={options} onInputChange={setValue}
    onChange={next => { spy(next); if (selectValue) setValue(next); }} /><button type="button">Outside field</button></>;
}
afterEach(cleanup);
describe("Combobox keyboard and selection contract", () => {
  it.each(["Escape", "Tab", "outside", "choice"])("retains the displayed controlled draft filter after %s and reopening", (closeBy) => {
    const spy = vi.fn(); render(<DraftHarness spy={spy} />);
    const input = screen.getByRole("combobox"), outside = screen.getByRole("button", { name: "Outside field" });
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "production" } });
    expect(screen.getAllByRole("option")).toHaveLength(1); expect(screen.getByRole("option").textContent).toContain("Gateway");
    if (closeBy === "outside") fireEvent.pointerDown(screen.getByRole("button", { name: "Outside field" }));
    else if (closeBy === "choice") { fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); }
    else fireEvent.keyDown(input, { key: closeBy });
    expect(screen.queryByRole("listbox")).toBeNull(); expect((input as HTMLInputElement).value).toBe("production");
    if (closeBy === "choice") expect(spy).toHaveBeenLastCalledWith("BuildGateway");
    else expect(spy).not.toHaveBeenCalled();
    act(() => outside.focus()); expect(document.activeElement).toBe(outside);
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(1); expect(screen.getByRole("option").textContent).toContain("Gateway");
  });
  it("offers all options after a draft caller stores a valid chosen token", () => {
    render(<DraftHarness selectValue />); const input = screen.getByRole("combobox"), outside = screen.getByRole("button", { name: "Outside field" });
    act(() => input.focus()); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "production" } }); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLInputElement).value).toBe("Gateway");
    act(() => outside.focus()); act(() => input.focus()); expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(3); expect(screen.getAllByRole("option").some(row => row.textContent?.includes("Stargate"))).toBe(true);
  });
  it("replaces a pending query when its controlled selection is reset", () => {
    const view = render(<Combobox label="Reset" value="BuildGateway" options={options} onChange={vi.fn()} />);
    const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "no match" } });
    view.rerender(<Combobox label="Reset" value="BuildStargate" options={options} onChange={vi.fn()} />);
    expect((input as HTMLInputElement).value).toBe("Stargate");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
  it("keeps a portalled list inside the real dialog and consumes only the first Escape", () => {
    const close = vi.fn(); render(<Modal open title="Edit build" onClose={close}><Harness /></Modal>);
    const input = screen.getByRole("combobox"); fireEvent.focus(input);
    expect(screen.getByRole("dialog").contains(screen.getByRole("listbox"))).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" }); expect(close).not.toHaveBeenCalled(); expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
  });
  it("keeps focus in the input, skips disabled choices and commits with Enter", () => {
    const spy = vi.fn(); render(<Harness spy={spy} />); const input = screen.getByRole("combobox"); input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = input.getAttribute("aria-activedescendant"); expect(document.getElementById(active!)?.textContent).toContain("Stargate"); expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" }); expect(spy).toHaveBeenLastCalledWith("BuildStargate"); expect((input as HTMLInputElement).value).toBe("Stargate"); expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(input); expect(screen.getAllByRole("option")).toHaveLength(3);
  });
  it("searches friendly names, tokens and aliases without saving a query", () => {
    const spy = vi.fn(); render(<Harness spy={spy} />); const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "production" } }); expect(screen.getAllByRole("option")).toHaveLength(1); expect(spy).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "BuildStargate" } }); fireEvent.mouseDown(screen.getByRole("option")); fireEvent.click(screen.getByRole("option"));
    expect(spy).toHaveBeenLastCalledWith("BuildStargate");
  });
  it("closes with Escape, Tab and outside focus without trapping or changing the value", () => {
    const spy = vi.fn(); render(<Harness spy={spy} />); const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "none" } }); expect(screen.getByRole("status").textContent).toContain("No matching"); fireEvent.keyDown(input, { key: "Escape" }); expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input); fireEvent.keyDown(input, { key: "End" }); expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toContain("Stargate");
    fireEvent.keyDown(input, { key: "Tab" }); expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input); fireEvent.pointerDown(screen.getByRole("button", { name: "Next field" })); expect(screen.queryByRole("listbox")).toBeNull(); expect(spy).not.toHaveBeenCalled();
  });
  it("bounds large lists and exposes invalid or disabled states", () => {
    const view = render(<Combobox label="Many" value="unknown" onChange={vi.fn()} options={Array.from({ length: 100 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }))} invalid describedBy="error" />);
    const input = screen.getByRole("combobox"); fireEvent.focus(input); expect(screen.getAllByRole("option")).toHaveLength(60); expect(screen.getByRole("status").textContent).toContain("Type more"); expect(input.getAttribute("aria-invalid")).toBe("true");
    view.rerender(<Combobox label="Many" value="unknown" onChange={vi.fn()} options={options} disabled />); expect(input.getAttribute("aria-expanded")).toBe("false"); expect(screen.queryByRole("listbox")).toBeNull();
  });
});
