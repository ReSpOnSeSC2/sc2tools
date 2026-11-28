import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const getJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/serverApi", () => ({ getJson }));

import ProsOnLadderPage from "../page";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  getJson.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

/** The page is a server component: it reads the server's two gates, then draws the board in the right state at once. */
async function renderPage(status: unknown) {
  getJson.mockResolvedValue(status);
  return render(await ProsOnLadderPage());
}

describe("the Pros on Ladder page", () => {
  it("asks the server for the gates, and draws the closed state with no board request, when the board is off", async () => {
    await renderPage({ available: false, showNames: false });
    expect(getJson).toHaveBeenCalledWith("/v1/pros-on-ladder/status", expect.objectContaining({ revalidateSec: 300 }));
    expect(screen.getByText("Pros on Ladder is not available yet.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("promises pros, games and live links only when the server shows names", async () => {
    await renderPage({ available: true, showNames: false });
    expect(screen.getByText("Who is playing on the Grandmaster ladder right now.")).toBeTruthy();
    expect(screen.queryByText(/Known pros show/)).toBeNull();
    cleanup();
    await renderPage({ available: true, showNames: true });
    expect(screen.getByText(/Known pros show their last games and a link when they are live/)).toBeTruthy();
  });

  it("shapes the loading board like the board the server will show", async () => {
    const { container } = await renderPage({ available: true, showNames: false });
    const tiles = container.querySelectorAll("[aria-hidden]").length;
    cleanup();
    const named = await renderPage({ available: true, showNames: true });
    expect(named.container.querySelectorAll("[aria-hidden]").length).toBeGreaterThan(tiles);
  });

  it("still loads the board when the gate status cannot be read", async () => {
    await renderPage(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Pros on Ladder is not available yet.")).toBeNull();
  });
});
