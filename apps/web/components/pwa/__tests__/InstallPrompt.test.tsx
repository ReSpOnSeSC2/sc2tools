import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  });
});
