import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstallAppButton } from "../InstallAppButton";
const state = vi.hoisted(() => ({ available: false, platform: "unsupported", installed: false, promptInstall: vi.fn() }));
vi.mock("@/lib/pwa/install", () => ({ useInstallState: () => state }));
afterEach(() => { cleanup(); state.available = false; state.platform = "unsupported"; state.installed = false; state.promptInstall.mockReset(); });
it("hides unsupported and already-installed entrypoints", () => {
  const view = render(<InstallAppButton />); expect(screen.queryByRole("button")).toBeNull();
  state.platform = "ios-safari"; state.installed = true; view.rerender(<InstallAppButton />); expect(screen.queryByRole("button")).toBeNull();
});
it("offers supported manual paths even without a native prompt", () => {
  state.platform = "android"; render(<InstallAppButton />); expect(screen.getByRole("button", { name: "Install app" })).toBeTruthy();
});
it("prompts once and confirms accepted installation", async () => {
  state.available = true; state.platform = "desktop-chromium"; state.promptInstall.mockResolvedValue("accepted"); render(<InstallAppButton />);
  fireEvent.click(screen.getByRole("button", { name: "Install app" })); await screen.findByRole("status");
  expect(screen.getByRole("status").textContent).toBe("SC2 Tools installed. Find it on your home screen or app list."); expect(state.promptInstall).toHaveBeenCalledOnce();
});
