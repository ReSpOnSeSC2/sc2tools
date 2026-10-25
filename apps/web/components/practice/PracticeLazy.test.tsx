import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PracticeLazy } from "./PracticeLazy";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const Loaded = () => <button>Loaded practice action</button>;
describe("local practice chunk recovery", () => {
  it("keeps a rejected chunk local and invokes the import factory again on Retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loader = vi.fn().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValueOnce(Loaded);
    render(<PracticeLazy loader={loader} componentProps={{}} label="practice controls" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry practice controls" }));
    expect(await screen.findByRole("button", { name: "Loaded practice action" })).toBeTruthy(); expect(loader).toHaveBeenCalledTimes(2);
  });
  it("settles a held chunk at20s and can recover without reloading the page", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    const loader = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(Loaded);
    render(<PracticeLazy loader={loader} componentProps={{}} label="Ghost grade" fallback={<span>Loading fixture</span>} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    fireEvent.click(screen.getByRole("button", { name: "Retry Ghost grade" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Loaded practice action" })).toBeTruthy();
  });
});
