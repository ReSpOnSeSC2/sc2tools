import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PublicReplayDownloadButton } from "../PublicReplayDownloadButton";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "https://api.example.test",
}));

vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
  }),
}));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PublicReplayDownloadButton", () => {
  it("requests a fresh share-scoped URL only after click and starts a sanitized download", async () => {
    const signedUrl = "https://replays.example.test/private/game?signature=short-lived";
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        url: signedUrl,
        filename: "Crimson Court - Rival/Name.SC2Replay",
        expiresIn: 60,
      })),
    });
    const clickedAnchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function capture(this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      },
    );

    const { container } = render(
      <PublicReplayDownloadButton
        handle="coach/name"
        gameId="game/42"
        available
        sizeBytes={1_572_864}
        showLabel
      />,
    );

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("replays.example.test");
    expect(container.querySelector("a[href]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    await waitFor(() => {
      expect(mocks.fetch).toHaveBeenCalledWith(
        "https://api.example.test/v1/public/replays/coach%2Fname/game%2F42/download",
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      expect(clickedAnchors).toHaveLength(1);
    });
    expect(String(mocks.fetch.mock.calls[0]?.[0])).not.toContain("/v1/games/");
    expect(clickedAnchors[0].href).toBe(signedUrl);
    expect(clickedAnchors[0].download).toBe(
      "Crimson Court - Rival-Name.SC2Replay",
    );
    expect(clickedAnchors[0].isConnected).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Replay download started");
  });

  it("disables the public control when the API row says no replay is archived", () => {
    render(
      <PublicReplayDownloadButton
        handle="coach"
        gameId="game-42"
        available={false}
        showLabel
      />,
    );

    const button = screen.getByRole("button", { name: "Replay unavailable" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("treats share revocation or a missing replay as a retryable 404 without falling back to owner auth", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });
    render(
      <PublicReplayDownloadButton
        handle="coach"
        gameId="game-42"
        available
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry replay download" })).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "unavailable or sharing has been turned off",
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetch.mock.calls[0]?.[0])).toContain(
      "/v1/public/replays/coach/game-42/download",
    );
    expect(String(mocks.fetch.mock.calls[0]?.[0])).not.toContain("/v1/games/");
  });
});
