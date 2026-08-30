import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicReplayShareButton } from "../PublicReplayShareButton";

const toastSuccess = vi.fn();
const originalSecureContext = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: { success: toastSuccess } }),
}));

afterEach(() => {
  cleanup();
  toastSuccess.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalSecureContext) {
    Object.defineProperty(window, "isSecureContext", originalSecureContext);
  } else {
    Reflect.deleteProperty(window, "isSecureContext");
  }
});

describe("PublicReplayShareButton", () => {
  it("opens the native mobile share sheet with the canonical replay-page URL", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: undefined });
    render(
      <PublicReplayShareButton
        path="/players/reaver-0123456789/replays"
        playerName="Reaver"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share Reaver's replay page" }));

    await waitFor(() => expect(share).toHaveBeenCalledWith({
      title: "Reaver's StarCraft II replays",
      text: "View and download Reaver's shared StarCraft II replays.",
      url: `${window.location.origin}/players/reaver-0123456789/replays`,
    }));
    expect(await screen.findByText("Shared")).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalledWith("Replay page shared");
  });

  it("copies the canonical link when native sharing is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    render(
      <PublicReplayShareButton
        path="/players/reaver-0123456789/replays"
        playerName="Reaver"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share Reaver's replay page" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/players/reaver-0123456789/replays`,
    ));
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalledWith("Replay page link copied");
  });

  it("treats closing the native share sheet as a quiet cancellation", async () => {
    const share = vi.fn().mockRejectedValue({ name: "AbortError" });
    const writeText = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });
    render(
      <PublicReplayShareButton
        path="/players/reaver-0123456789/replays"
        playerName="Reaver"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share Reaver's replay page" }));

    expect(await screen.findByText("Share replay page")).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to copying when the native share sheet fails", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share_failed"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    render(
      <PublicReplayShareButton
        path="/players/reaver-0123456789/replays"
        playerName="Reaver"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share Reaver's replay page" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/players/reaver-0123456789/replays`,
    ));
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalledWith("Replay page link copied");
  });
});
