import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameStoryPanel } from "../GameStoryPanel";
import { STORY_INPUT } from "./gameStoryUiFixtures";

beforeAll(async () => { await import("../GameStoryCard"); });
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
afterEach(cleanup);

describe("lazy game story layout", () => {
  it("keeps Why you lost selected and Mechanics mounted while the story becomes available", async () => {
    render(<GameStoryPanel input={{ ...STORY_INPUT, result: "Defeat" }} onSeek={vi.fn()} mechanics={<div data-testid="stable-mechanics">Mechanics sample</div>} lossAutopsy={<h2>Why you lost</h2>} />);
    const mechanics = screen.getByTestId("stable-mechanics");
    const loss = screen.getByRole("tab", { name: "Why you lost" });
    expect(loss.getAttribute("aria-selected")).toBe("true");
    const story = await screen.findByRole("tab", { name: "Game story" });
    expect(screen.getByTestId("stable-mechanics")).toBe(mechanics);
    loss.focus();
    fireEvent.keyDown(loss, { key: "ArrowRight" });
    expect(story.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(story);
    expect(screen.getByRole("heading", { name: "Game story" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Why you lost" })).toBeNull();
    fireEvent.keyDown(story, { key: "Home" });
    expect(screen.getByRole("heading", { name: "Why you lost" })).toBeTruthy();
    expect(screen.getByTestId("stable-mechanics")).toBe(mechanics);
  });

  it("shows a win or draw directly and gives Mechanics the full row when nothing stands out", async () => {
    const { rerender } = render(<GameStoryPanel input={STORY_INPUT} onSeek={vi.fn()} mechanics={<h2>Mechanics</h2>} />);
    expect(await screen.findByRole("heading", { name: "Game story" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    rerender(<GameStoryPanel input={{ gameId: "empty", result: "Draw", casualtyEvents: [] }} onSeek={vi.fn()} mechanics={<h2>Mechanics</h2>} />);
    await waitFor(() => expect(screen.queryByTestId("game-story-card")).toBeNull());
    expect(screen.getByTestId("game-story-layout").className).toContain("grid-cols-1");
    expect(screen.getByTestId("game-story-layout").className).not.toContain("md:grid-cols-2");
    expect(screen.queryByText(/loss autopsy only/)).toBeNull();
  });
});
