import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE, type StudioBuildProfile } from "@/lib/multichat/useStudioState";
import { BuildProfileChart, BuildProfileWidget } from "../BuildProfileWidget";

let mockState = { ...DEFAULT_STUDIO_STATE, loaded: true, snapshotReady: true };
vi.mock("@/lib/multichat/useStudioState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/multichat/useStudioState")>();
  return { ...actual, useStudioState: () => mockState };
});

const profile: StudioBuildProfile = {
  title: "Test build",
  labels: { ...DEFAULT_BUILD_PROFILE.labels },
  ratings: { aggressiveness: 5, defensiveness: 1, executionDifficulty: 3, popularity: 2, micro: 4 },
  visible: true,
};
afterEach(() => {
  cleanup();
  mockState = { ...DEFAULT_STUDIO_STATE, loaded: true, snapshotReady: true };
});

describe("BuildProfileWidget", () => {
  it("starts completely transparent without rated content", () => {
    render(<BuildProfileWidget token="test-token" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("build-profile-hidden")).toBeTruthy();
  });
  it("shows five independently rated axes with the correct 1–5 scale", () => {
    mockState = { ...mockState, buildProfile: profile };
    const { container } = render(<BuildProfileWidget token="test-token" />);
    expect(screen.getByText("Test build")).toBeTruthy();
    expect(screen.getByText("Personal ratings · 1–5")).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="build-profile-point"]')).toHaveLength(5);
    expect(screen.getByRole("img").textContent).toContain("Aggressiveness: 5 out of 5");
    expect(screen.getByRole("img").textContent).toContain("Defensiveness: 1 out of 5");
    const points = screen.getByTestId("build-profile-area").getAttribute("points")!.split(" ");
    expect(points[0]).toBe("320,149"); // 5 is the outermost ring, not 5 percent.
  });
  it("hides immediately while retaining the saved scores, and shows them again", () => {
    mockState = { ...mockState, buildProfile: profile };
    const view = render(<BuildProfileWidget token="test-token" />);
    mockState = { ...mockState, buildProfile: { ...profile, visible: false } };
    view.rerender(<BuildProfileWidget token="test-token" />);
    expect(screen.queryByRole("img")).toBeNull();
    mockState = { ...mockState, buildProfile: profile };
    view.rerender(<BuildProfileWidget token="test-token" />);
    expect(screen.getByText("5/5")).toBeTruthy();
  });
  it("fails closed before authoritative state or with incomplete ratings", () => {
    mockState = { ...mockState, snapshotReady: false, buildProfile: profile };
    const view = render(<BuildProfileWidget token="test-token" />);
    expect(screen.queryByRole("img")).toBeNull();
    mockState = { ...mockState, snapshotReady: true, buildProfile: { ...profile, ratings: { ...profile.ratings, micro: null } } };
    view.rerender(<BuildProfileWidget token="test-token" />);
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("handles a long title as text rather than executable markup", () => {
    render(<BuildProfileChart profile={{ ...profile, title: "<img src=x onerror=alert(1)>" }} />);
    expect(screen.getByRole("heading").textContent).toContain("<img");
    expect(screen.queryByRole("img", { name: "x" })).toBeNull();
  });
  it("shows the saved custom labels and updates them without changing scores", () => {
    mockState = { ...mockState, buildProfile: { ...profile, labels: { ...profile.labels, micro: "Unit control" } } };
    const view = render(<BuildProfileWidget token="test-token" />);
    expect(screen.getByRole("img").textContent).toContain("Unit control: 4 out of 5");
    mockState = { ...mockState, buildProfile: { ...profile, labels: { ...profile.labels, micro: "Micro demand" } } };
    view.rerender(<BuildProfileWidget token="test-token" />);
    expect(screen.getByRole("img").textContent).toContain("Micro demand: 4 out of 5");
    expect(screen.getByRole("img").textContent).not.toContain("Unit control");
  });
});
