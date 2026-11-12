import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalCardShareButton } from "@/components/ui/PersonalCardShareButton";
import { fingerprintShareCard, sessionReportShareCard } from "@/lib/personalShareCards";
import { practiceGradeShareCard } from "@/lib/practice/practiceGradeShareCard";
import type { ShareDelivery } from "@/components/analyzer/arcade/ShareCard";

const { deliverShareCard, trackCardShared } = vi.hoisted(() => ({
  deliverShareCard: vi.fn(), trackCardShared: vi.fn(),
}));
vi.mock("@/lib/analytics/shareEvents", () => ({ trackCardShared }));
vi.mock("@/components/analyzer/arcade/ShareCard", async (original) => ({
  ...await original<typeof import("@/components/analyzer/arcade/ShareCard")>(), deliverShareCard,
}));

const fingerprint = fingerprintShareCard({
  matchup: "PvZ", games: 20, distinctBuilds: 8, buildSamples: 19, averageSeconds: 405, durationSamples: 18,
});
const session = sessionReportShareCard({ games: 9, wins: 6, losses: 2, unknown: 1, playedMin: 77, durationSamples: 8 });
const png = new Blob(["png"], { type: "image/png" });
const fillText = vi.fn();

beforeEach(() => {
  const context = {
    createLinearGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(), fillText, measureText: () => ({ width: 60 }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(png));
});

afterEach(() => {
  cleanup();
  deliverShareCard.mockReset();
  trackCardShared.mockReset();
  fillText.mockClear();
  vi.restoreAllMocks();
});

describe("PersonalCardShareButton", () => {
  it("delivers the fingerprint once and preserves focus during and after sharing", async () => {
    let settle: (result: ShareDelivery) => void = () => undefined;
    deliverShareCard.mockImplementationOnce(() => new Promise<ShareDelivery>((resolve) => { settle = resolve; }));
    render(<PersonalCardShareButton card={fingerprint} label="Share fingerprint" />);
    const button = screen.getByRole("button", { name: "Share fingerprint" });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(deliverShareCard).toHaveBeenCalledTimes(1));
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(trackCardShared).not.toHaveBeenCalled();
    expect(deliverShareCard).toHaveBeenCalledWith({
      blob: png, title: "Skill fingerprint", filename: "sc2tools-fingerprint.png",
      text: "Skill fingerprint\nPvZ · 1v1 playstyle\nGames in sample: 20\nBuilds detected in 19 games: 8\nAverage duration in 18 games: 6.8 min\n\nhttps://sc2tools.com",
    });
    expect(fillText).toHaveBeenCalledWith("PvZ · 1v1 playstyle", expect.any(Number), expect.any(Number));
    await act(async () => { settle({ shared: true, method: "clipboard_image" }); });
    expect(trackCardShared.mock.calls).toEqual([[{ card: "fingerprint", method: "clipboard_image" }]]);
    expect(screen.getByRole("status").textContent).toBe("Skill fingerprint copied");
    expect(document.activeElement).toBe(button);
  });

  it("does not count a dismissed session card or show success feedback", async () => {
    deliverShareCard.mockResolvedValueOnce({ shared: false, method: null });
    render(<PersonalCardShareButton card={session} label="Share session report" />);
    const button = screen.getByRole("button", { name: "Share session report" });
    fireEvent.click(button);
    await waitFor(() => expect(deliverShareCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute("aria-busy")).toBe(false));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(trackCardShared).not.toHaveBeenCalled();
  });

  it("offers retry on an image failure and counts only the successful session delivery", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => callback(null));
    deliverShareCard.mockResolvedValueOnce({ shared: true, method: "download" });
    render(<PersonalCardShareButton card={session} label="Share session report" />);
    const button = screen.getByRole("button", { name: "Share session report" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    expect(trackCardShared).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect((await screen.findByRole("status")).textContent).toBe("Session report saved");
    expect(deliverShareCard).toHaveBeenCalledWith(expect.objectContaining({ filename: "sc2tools-session-report.png" }));
    expect(trackCardShared.mock.calls).toEqual([[{ card: "session_report", method: "download" }]]);
  });

  it("fits public creator credit and links back to the Practice Link", async () => {
    deliverShareCard.mockResolvedValueOnce({ shared: true, method: "download" });
    const card = practiceGradeShareCard({ title: "Recorded opener", creator: "Creator", path: "/b/opener" }, "A");
    render(<PersonalCardShareButton card={card} label="Share grade card" />);
    fireEvent.click(screen.getByRole("button", { name: "Share grade card" }));
    expect((await screen.findByRole("status")).textContent).toBe("Practice Link grade saved");
    expect(fillText).toHaveBeenCalledWith(card.subtitle, expect.any(Number), expect.any(Number), expect.any(Number));
    expect(fillText).toHaveBeenCalledWith("sc2tools.com/b/opener", expect.any(Number), expect.any(Number));
    expect(deliverShareCard).toHaveBeenCalledWith(expect.objectContaining({
      text: "Practice Link grade\nRecorded opener · Build by Creator\nGrade: A\n\nhttps://sc2tools.com/b/opener",
    }));
  });
});
