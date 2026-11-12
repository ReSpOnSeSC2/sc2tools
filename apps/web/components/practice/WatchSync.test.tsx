// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadYouTubeApi } from "@/lib/youtubeIframeApi";
import { currentWatchStep, WatchSync } from "./WatchSync";

vi.mock("@/lib/youtubeIframeApi", () => ({ loadYouTubeApi: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("Practice Link video clock", () => {
  const steps = [
    { t: 30, supply: 20, action: "BuildCyberneticsCore" },
    { t: 10, supply: 14, action: "BuildGateway" },
    { t: null, supply: 24, action: "TrainStalker" },
    { t: 30, supply: 21, action: "BuildPylon" },
  ];

  it("subtracts the video offset and highlights the latest due timed step", () => {
    expect(currentWatchStep(steps, 29, 20)).toBe(-1);
    expect(currentWatchStep(steps, 30, 20)).toBe(1);
    expect(currentWatchStep(steps, 50, 20)).toBe(3);
    expect(currentWatchStep(steps, 32, 20)).toBe(1);
  });

  it("keeps keyboard focus in the video group while playback starts and retries", async () => {
    vi.mocked(loadYouTubeApi).mockRejectedValueOnce(new Error("Fixture failure")).mockImplementation(() => new Promise(() => {}));
    render(<WatchSync videoId="AbCdEf12345" title="Opening" offset={20} steps={steps} />);
    const video = screen.getByRole("group", { name: "Build video" });
    const play = screen.getByRole("button", { name: "Play video" });
    play.focus();
    fireEvent.click(play);
    expect(document.activeElement).toBe(video);
    const retry = await screen.findByRole("button", { name: "Retry video" });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(video);
    expect(screen.getByRole("status").textContent).toContain("Loading video");
  });
});
