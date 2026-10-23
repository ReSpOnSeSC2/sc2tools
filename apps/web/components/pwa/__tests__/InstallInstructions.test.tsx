import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstallInstructions } from "../InstallInstructions";
afterEach(cleanup);
it("shows Safari-first iOS steps in the shared accessible Modal", async () => {
  const close = vi.fn(); render(<InstallInstructions platform="ios-other" onClose={close} />);
  const dialog = screen.getByRole("dialog", { name: "Install SC2 Tools on iPhone" }); await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(screen.getByText("Open this page in Safari first.")).toBeTruthy(); expect(screen.getByText("Add to Home Screen")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
});
it("keeps the Android browser-menu fallback", () => {
  render(<InstallInstructions platform="android" onClose={() => {}} />); expect(screen.getByRole("dialog", { name: "Install SC2 Tools on Android" })).toBeTruthy(); expect(screen.getByText("Install app")).toBeTruthy(); expect(screen.getByText(/top-right of Chrome/)).toBeTruthy();
});
