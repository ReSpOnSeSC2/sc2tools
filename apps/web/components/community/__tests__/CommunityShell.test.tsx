import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CommunityShell } from "../CommunityShell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/community",
  useRouter: () => ({ push: () => undefined }),
}));

describe("CommunityShell", () => {
  afterEach(() => cleanup());

  test("renders both tabs (Community Builds + Leaderboard)", () => {
    render(
      <CommunityShell active="builds">
        <div>builds-body</div>
      </CommunityShell>,
    );
    expect(screen.getByRole("tab", { name: /community builds/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /leaderboard/i })).toBeTruthy();
    expect(screen.getByText("builds-body")).toBeTruthy();
  });

  test("marks the leaderboard tab selected when active=leaderboard", () => {
    render(
      <CommunityShell active="leaderboard">
        <div>lb-body</div>
      </CommunityShell>,
    );
    const lbTrigger = screen.getByRole("tab", { name: /leaderboard/i });
    expect(lbTrigger.getAttribute("aria-selected")).toBe("true");
  });
});
