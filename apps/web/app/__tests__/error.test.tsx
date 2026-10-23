import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The route error boundary: an auth-aware way out, a copyable error
 * reference and a prefilled problem report (the report form itself is
 * covered by errorBoundaries.test.tsx). Clerk, the router and Sentry are
 * mocked.
 */
const harness = vi.hoisted(() => ({
  pathname: "/community/builds/broken",
  auth: { isLoaded: true, isSignedIn: false },
  captureException: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/sentry", () => ({ captureException: harness.captureException }));

import RouteError from "@/app/error";

function renderError(digest?: string) {
  const reset = vi.fn();
  const error = Object.assign(new Error("boom"), digest ? { digest } : {});
  render(<RouteError error={error} reset={reset} />);
  return reset;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.pathname = "/community/builds/broken";
  harness.auth = { isLoaded: true, isSignedIn: false };
});

describe("route error page", () => {
  it("retries in place", () => {
    const reset = renderError("4021");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("sends a signed-out visitor home, never to /app", () => {
    renderError("4021");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(document.querySelector('a[href^="/app"]')).toBeNull();
  });

  it("sends a signed-in player to the dashboard", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    renderError("4021");
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/app");
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
  });

  it("shows the error reference and copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderError("1234567890");
    expect(screen.getByText("1234567890").tagName).toBe("CODE");
    expect(screen.getByText(/Error reference:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy error reference" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied."));
    expect(writeText).toHaveBeenCalledWith("1234567890");
  });

  it("selects the reference when the clipboard is blocked", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    renderError("1234567890");
    fireEvent.click(screen.getByRole("button", { name: "Copy error reference" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Press Ctrl+C"));
    expect(window.getSelection()?.toString()).toBe("1234567890");
  });

  it("prefills a visitor's email report with the reference and the path", () => {
    harness.pathname = "/community/builds/broken";
    renderError("4021");
    expect(screen.queryByRole("button", { name: "Report this problem" })).toBeNull();
    const href = screen.getByRole("link", { name: "Email us about it" }).getAttribute("href") ?? "";
    const url = new URL(href);
    expect(url.protocol).toBe("mailto:");
    expect(url.searchParams.get("subject")).toBe("Error on /community/builds/broken (ref 4021)");
    expect(url.searchParams.get("body")).toContain("Error reference: 4021\nPage: /community/builds/broken");
  });

  it("offers a signed-in player the report form", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    renderError("4021");
    expect(screen.getByRole("button", { name: "Report this problem" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Email us about it" })).toBeNull();
  });

  it("still offers a report without a digest", () => {
    renderError();
    expect(screen.queryByRole("button", { name: "Copy error reference" })).toBeNull();
    const href = screen.getByRole("link", { name: "Email us about it" }).getAttribute("href") ?? "";
    expect(new URL(href).searchParams.get("subject")).toBe("Error on /community/builds/broken");
  });

  it("keeps the error page out of search results", () => {
    render(<RouteError error={new Error("x")} reset={vi.fn()} />);
    // React hoists the tag into <head>.
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
  });
});
