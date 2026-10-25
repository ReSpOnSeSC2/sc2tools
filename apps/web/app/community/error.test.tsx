// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ path: "/community/builds/synthetic" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
import CommunityError from "./error";
afterEach(cleanup);
describe("cold Community detail recovery", () => {
  it.each([
    ["/community/builds/synthetic", "This build is temporarily unavailable"],
    ["/community/authors/synthetic", "This profile is temporarily unavailable"],
    ["/community/opponents/synthetic", "Opponent profile temporarily unavailable"],
    [null, "Community builds are temporarily unavailable"],
  ])("retains scoped recovery for %s", (path, title) => {
    state.path = path; render(<CommunityError />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(path || "/community");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
  });
});
