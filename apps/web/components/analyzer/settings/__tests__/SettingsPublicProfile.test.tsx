import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsPublicProfile } from "../SettingsPublicProfile";

/**
 * Nothing in the product linked to /p/<handle>: users with a live public
 * profile had no way to find or share it. Settings → Profile now shows
 * the link when the profile is live and explains the opt-in otherwise.
 */

type Api = { data?: unknown; error?: { status: number }; isLoading: boolean };
const responses = new Map<string, Api>();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) =>
    (path && responses.get(path)) || { data: undefined, error: undefined, isLoading: false },
}));

const ME = "/v1/me";
const PROFILE = "/v1/public/profile/user-123";

describe("SettingsPublicProfile", () => {
  beforeEach(() => {
    responses.clear();
    responses.set(ME, { data: { userId: "user-123" }, isLoading: false });
  });
  afterEach(cleanup);

  test("links to the live profile and offers to copy it", () => {
    responses.set(PROFILE, { data: { profile: {} }, isLoading: false });
    render(<SettingsPublicProfile />);
    const view = screen.getByRole("link", { name: /view profile/i });
    expect(view.getAttribute("href")).toBe("/p/user-123");
    expect(screen.getByRole("button", { name: /copy link/i })).toBeTruthy();
    expect(screen.getByText("sc2tools.com/p/user-123")).toBeTruthy();
  });

  test("a 404 explains how to turn the profile on", () => {
    responses.set(PROFILE, { error: { status: 404 }, isLoading: false });
    render(<SettingsPublicProfile />);
    expect(screen.queryByRole("link", { name: /view profile/i })).toBeNull();
    expect(screen.getByRole("link", { name: /custom builds/i }).getAttribute("href")).toBe(
      "/builds",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("other failures are reported instead of pretending it's off", () => {
    responses.set(PROFILE, { error: { status: 503 }, isLoading: false });
    render(<SettingsPublicProfile />);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.t check/i);
  });
});
