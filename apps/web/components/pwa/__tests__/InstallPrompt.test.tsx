import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { startInstallCapture } from "@/lib/pwa/install";
import { InstallPrompt } from "../InstallPrompt";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("InstallPrompt", () => {
  it("links the install how-to from the banner", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
    render(<InstallPrompt />);
    await screen.findByRole("region", { name: "Install SC2 Tools as a mobile app" });
    const link = screen.getByRole("link", { name: "How the app works" });
    expect(link.getAttribute("href")).toBe("/help/install-app");
    // The install CTA is the shared full-width primary Button, not a hand-written copy.
    expect(screen.getByRole("button", { name: "How to install" }).className).toBe(buttonClassName({ fullWidth: true }));
  });
});


it("clears dismissal on every new native prompt event, even if availability was already true", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android Chrome/120"); startInstallCapture();
  const prompt = () => { const event = new Event("beforeinstallprompt", { cancelable: true }); Object.assign(event, { prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: "dismissed" }) }); window.dispatchEvent(event); };
  prompt(); render(<InstallPrompt />); await screen.findByRole("region", { name: "Install SC2 Tools as a mobile app" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss install prompt" })); expect(screen.queryByRole("region")).toBeNull();
  expect(localStorage.getItem("sc2tools.pwa.installPromptDismissedAt")).not.toBeNull();
  act(prompt); await screen.findByRole("region", { name: "Install SC2 Tools as a mobile app" });
  expect(localStorage.getItem("sc2tools.pwa.installPromptDismissedAt")).toBeNull();
  expect(screen.getByRole("button", { name: "Install app" }).className).toBe(buttonClassName({ fullWidth: true }));
  expect(screen.getByRole("button", { name: "Or install via Chrome menu" }).className)
    .toBe(buttonClassName({ variant: "ghost", size: "sm", fullWidth: true }));
});
