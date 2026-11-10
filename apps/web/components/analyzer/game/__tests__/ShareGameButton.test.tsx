import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { ShareGameButton } from "../ShareGameButton";
import type { GameSummary } from "../types";

/**
 * "Share this game": the battle card goes through the shared delivery
 * pipeline, a delivered card is counted once by path, and a dismissed
 * share sheet is neither counted nor announced.
 */

const mocks = vi.hoisted(() => ({
  renderBattleCardPng: vi.fn(),
  deliverShareCard: vi.fn(),
  trackCardShared: vi.fn(),
}));
vi.mock("@/lib/battleCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/battleCard")>()),
  renderBattleCardPng: mocks.renderBattleCardPng,
}));
vi.mock("@/components/analyzer/arcade/ShareCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/analyzer/arcade/ShareCard")>()),
  deliverShareCard: mocks.deliverShareCard,
}));
vi.mock("@/lib/analytics/shareEvents", () => ({ trackCardShared: mocks.trackCardShared }));

const GAME: GameSummary = {
  gameId: "2026-11-01T20:00:00|SecretFoe#1234|Alcyone LE|700",
  result: "Victory",
  map: "Alcyone LE",
  myRace: "Protoss",
  myBuild: "PvZ - Stargate Opener",
  myMmr: 4100,
  opponent: {
    displayName: "SecretFoe#1234",
    pulseId: "1-S2-1-9988776",
    race: "Zerg",
    mmr: 4237,
    strategy: "Zerg - Roach Push",
  },
};

beforeEach(() => {
  mocks.renderBattleCardPng.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  mocks.deliverShareCard.mockReset();
  mocks.trackCardShared.mockReset();
});
afterEach(cleanup);

function share() {
  render(
    <ToastProvider>
      <ShareGameButton game={GAME} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Share this game as an image" }));
}

describe("ShareGameButton", () => {
  it("sends text that carries no opponent name, id or exact rating", async () => {
    mocks.deliverShareCard.mockResolvedValue({ shared: true, method: "web_share" });
    share();
    await waitFor(() => expect(mocks.deliverShareCard).toHaveBeenCalledTimes(1));

    const delivery = mocks.deliverShareCard.mock.calls[0][0];
    expect(delivery.title).toBe("SC2 Battle Card");
    expect(delivery.filename).toBe("sc2-pvz-victory.png");
    expect(delivery.text).toContain("Victory — PvZ on Alcyone LE");
    expect(delivery.text).toContain("MMR 4100 · opponent about 100 higher");
    for (const secret of ["SecretFoe", "9988776", "4237", "137"]) {
      expect(`${delivery.text}\n${delivery.filename}`).not.toContain(secret);
    }
  });

  it.each([
    ["web_share", "Battle card shared"],
    ["clipboard_image", "Battle card copied"],
    ["clipboard_text", "Battle card copied"],
    ["download", "Battle card saved"],
  ] as const)("counts a card delivered by %s and says so", async (method, toast) => {
    mocks.deliverShareCard.mockResolvedValue({ shared: true, method });
    share();

    expect(await screen.findByText(toast)).toBeTruthy();
    expect(mocks.trackCardShared).toHaveBeenCalledTimes(1);
    expect(mocks.trackCardShared).toHaveBeenCalledWith({ card: "battle_card", method });
  });

  it("neither counts nor announces a dismissed share sheet", async () => {
    mocks.deliverShareCard.mockResolvedValue({ shared: false, method: null });
    share();
    await waitFor(() => expect(mocks.deliverShareCard).toHaveBeenCalledTimes(1));

    // The button comes back to life once the attempt is over.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share this game as an image" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(mocks.trackCardShared).not.toHaveBeenCalled();
    expect(screen.queryByText(/Battle card (shared|copied|saved)/)).toBeNull();
    expect(screen.queryByText("Share failed")).toBeNull();
  });

  it("reports a card that could not be drawn, without counting it", async () => {
    mocks.renderBattleCardPng.mockResolvedValue(null);
    share();

    expect(await screen.findByText("Couldn't render the battle card")).toBeTruthy();
    expect(mocks.deliverShareCard).not.toHaveBeenCalled();
    expect(mocks.trackCardShared).not.toHaveBeenCalled();
  });
});
