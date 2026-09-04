import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReplayDownloadButton } from "../ReplayDownloadButton";

const apiCallMock = vi.fn();
const getTokenMock = vi.fn(async () => "test-token");

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

beforeEach(() => {
  apiCallMock.mockReset();
  getTokenMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReplayDownloadButton", () => {
  it("uses the supplied authorized path for a delegated replay download", async () => {
    apiCallMock.mockResolvedValue({
      url: "https://replays.example.test/signed/coaching-game?token=secret",
      filename: "coaching-game.SC2Replay",
      expiresIn: 60,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <ReplayDownloadButton
        gameId="game/42"
        available
        downloadPath="/v1/coaching/assignments/plan-1/games/game%2F42/replay-download"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    await waitFor(() => {
      expect(apiCallMock).toHaveBeenCalledWith(
        getTokenMock,
        "/v1/coaching/assignments/plan-1/games/game%2F42/replay-download",
      );
    });
  });

  it("requests a signed URL with Clerk auth and triggers a sanitized download", async () => {
    apiCallMock.mockResolvedValue({
      url: "https://replays.example.test/signed/game?token=secret",
      filename: "2026-08-11 - Crimson Court - vs Rival/Name.SC2Replay",
      expiresIn: 60,
    });
    const clickedAnchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function capture(this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      },
    );

    render(
      <ReplayDownloadButton
        gameId="game/42"
        available
        filename="fallback.SC2Replay"
        sizeBytes={1536}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    await waitFor(() => {
      expect(apiCallMock).toHaveBeenCalledWith(
        getTokenMock,
        "/v1/games/game%2F42/replay-download",
      );
      expect(clickedAnchors).toHaveLength(1);
    });
    const [clickedAnchor] = clickedAnchors;
    expect(clickedAnchor.href).toBe(
      "https://replays.example.test/signed/game?token=secret",
    );
    expect(clickedAnchor.download).toBe(
      "2026-08-11 - Crimson Court - vs Rival-Name.SC2Replay",
    );
    expect(clickedAnchor.isConnected).toBe(false);
    expect(
      screen.getByRole("button", { name: "Download replay" }).getAttribute(
        "aria-busy",
      ),
    ).toBeNull();
  });

  it("locks duplicate clicks while the signed URL is loading", async () => {
    let resolveRequest!: (value: {
      url: string;
      filename: string;
      expiresIn: number;
    }) => void;
    apiCallMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<ReplayDownloadButton gameId="g1" available />);
    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    const loading = screen.getByRole("button", { name: "Downloading replay" });
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(loading);
    expect(apiCallMock).toHaveBeenCalledTimes(1);

    resolveRequest({
      url: "https://replays.example.test/g1?signature=ok",
      filename: "g1.SC2Replay",
      expiresIn: 60,
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Download replay" })).toBeTruthy();
    });
  });

  it("renders a useful unavailable state without making a request", () => {
    render(
      <ReplayDownloadButton gameId="g1" available={false} mobile />,
    );

    const button = screen.getByRole("button", { name: "Replay unavailable" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toContain("Replay unavailable");
    expect(
      screen.getByText(/Update to the latest desktop agent, then run Re-sync/i),
    ).toBeTruthy();
    fireEvent.click(button);
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it("surfaces an expired or missing replay as a retryable error", async () => {
    apiCallMock.mockRejectedValue({
      status: 404,
      code: "replay_unavailable",
      message: "Not found.",
    });
    render(<ReplayDownloadButton gameId="g1" available />);

    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Retry replay download" }),
      ).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Update to the latest desktop agent, then run Re-sync",
    );
  });
});
