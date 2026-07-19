import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SettingsHelp } from "../SettingsHelp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsHelp", () => {
  it("renders every guide section and the support email", () => {
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    for (const heading of [
      /Getting started/,
      /Dashboard & analyzer/,
      /OBS overlay setup/,
      /Multi-platform chat \(Twitch/,
      /Stream Dock \(your control panel\)/,
      /Viewer engagement: XP/,
      /Troubleshooting & support/,
    ]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    expect(
      screen.getByRole("link", { name: "responsecoaching@gmail.com" }),
    ).toBeTruthy();
    // The commands card is embedded with the full command list.
    expect(screen.getByText("!rank")).toBeTruthy();
    expect(screen.getByText("!opponent")).toBeTruthy();
  });

  it("copies the bio text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy for your bio/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("!win");
    expect(text).toContain("CHAT COMMANDS");
  });
});
