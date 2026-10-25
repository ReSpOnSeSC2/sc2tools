import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenPicker } from "./TokenPicker";
afterEach(cleanup);
function Harness({ race = "Protoss", initial = "BuildStargate", spy = vi.fn() }: { race?: string; initial?: string; spy?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <TokenPicker value={value} race={race} onChange={next => { spy(next); setValue(next); }} />;
}
describe("TokenPicker in a rule draft", () => {
  it("shows friendly labels and stores the chosen exact action token", () => {
    const spy = vi.fn(); render(<Harness spy={spy} />); const input = screen.getByRole("combobox"); expect((input as HTMLInputElement).value).toBe("Stargate");
    fireEvent.change(input, { target: { value: "Gateway" } }); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith("BuildGateway"); expect((input as HTMLInputElement).value).toBe("Gateway");
  });
  it("filters by race, surfaces proxy eligibility and retains unknown text for correction", () => {
    render(<Harness race="Terran" initial="BuildMissing" />); const input = screen.getByRole("combobox"); expect(input.getAttribute("aria-invalid")).toBe("true"); expect(screen.getByText(/Unknown action/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Stargate" } }); expect(screen.queryByRole("option")).toBeNull();
    fireEvent.change(input, { target: { value: "Barracks" } }); expect(screen.getAllByRole("option").some(row => row.textContent?.includes("Proxy eligible"))).toBe(true);
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
