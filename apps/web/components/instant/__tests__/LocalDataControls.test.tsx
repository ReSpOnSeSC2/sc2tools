/**
 * LocalDataControls — 7-day note, confirm-before-clear, storage failures.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clearTryData: vi.fn(async () => undefined) }));
vi.mock("@/lib/instant/localStore", () => ({ clearTryData: mocks.clearTryData }));

import { LocalDataControls } from "../LocalDataControls";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocalDataControls", () => {
  it("says games expire after 7 days and clears them only after confirming", async () => {
    const onCleared = vi.fn();
    render(<LocalDataControls persisted onCleared={onCleared} />);
    expect(screen.getByText(/deleted automatically after 7 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    expect(mocks.clearTryData).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Clear local data");
    if (!confirm) throw new Error("confirm button missing");
    fireEvent.click(confirm);
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(mocks.clearTryData).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the dialog open with an explanation when the delete fails", async () => {
    mocks.clearTryData.mockRejectedValueOnce(new Error("blocked"));
    const onCleared = vi.fn();
    render(<LocalDataControls persisted onCleared={onCleared} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    const confirm = Array.from(screen.getByRole("dialog").querySelectorAll("button")).find(
      (button) => button.textContent === "Clear local data",
    );
    if (!confirm) throw new Error("confirm button missing");
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("explains in-memory mode and hides the clear button when storage is unavailable", () => {
    render(<LocalDataControls persisted={false} onCleared={vi.fn()} />);
    expect(screen.getByText(/disappears when you close the tab/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear local data" })).toBeNull();
  });
});
