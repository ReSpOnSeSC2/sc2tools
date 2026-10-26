// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthorizedGallery } from "./AuthorizedGallery";
import DesignPage, { dynamic } from "./page";
import { metadata } from "./layout";
import { GalleryRetry } from "./GalleryRetry";

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./DesignGallery", () => ({ DesignGallery: () => <div data-testid="authorized-gallery">Authorized examples</div> }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("server-authorized design gallery", () => {
  it("renders the gallery only after the current API account is explicitly admin", async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { isAdmin: true }, status: 200 });
    render(await AuthorizedGallery());
    expect(screen.getByTestId("authorized-gallery")).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith("/v1/me", { signal: expect.any(AbortSignal) });
    expect(mocks.api.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it.each([false, undefined, "true", 1, null])("denies non-admin or malformed roles: %s", async isAdmin => {
    mocks.api.mockResolvedValue({ ok: true, data: { isAdmin }, status: 200 });
    render(await AuthorizedGallery());
    expect(screen.queryByTestId("authorized-gallery")).toBeNull();
    expect(screen.getByText("Design gallery is admin only")).toBeTruthy();
  });

  it.each([401, 403, 0, 500, 503])("fails closed on an unsuccessful account check: %s", async status => {
    mocks.api.mockResolvedValue({ ok: false, status, error: "Sensitive internal message" });
    render(await AuthorizedGallery());
    expect(screen.queryByTestId("authorized-gallery")).toBeNull();
    expect(screen.queryByText("Sensitive internal message")).toBeNull();
    expect(screen.getByRole("button", { name: "Check access again" })).toBeTruthy();
  });

  it("fails closed when authentication or response reading throws", async () => {
    mocks.api.mockRejectedValue(new Error("Private token failure"));
    render(await AuthorizedGallery());
    expect(screen.queryByTestId("authorized-gallery")).toBeNull();
    expect(screen.getByText("Gallery access could not be checked")).toBeTruthy();
    expect(screen.queryByText("Private token failure")).toBeNull();
  });

  it("does not share a positive role result with a later denied request", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, data: { isAdmin: true }, status: 200 })
      .mockResolvedValueOnce({ ok: true, data: { isAdmin: false }, status: 200 });
    const first = render(await AuthorizedGallery());
    expect(screen.getByTestId("authorized-gallery")).toBeTruthy();
    first.unmount();
    render(await AuthorizedGallery());
    expect(screen.queryByTestId("authorized-gallery")).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung auth/token/body lookup and ignores a late positive result", async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: unknown) => void;
    mocks.api.mockReturnValue(new Promise(resolve => { resolveLookup = resolve; }));
    const pending = AuthorizedGallery();
    const signal = mocks.api.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(5000);
    render(await pending);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole("heading", { name: "Gallery access could not be checked" })).toBeTruthy();
    resolveLookup({ ok: true, data: { isAdmin: true }, status: 200 });
    await Promise.resolve();
    expect(screen.queryByTestId("authorized-gallery")).toBeNull();
  });

  it("clears the whole-request deadline after a settled access check", async () => {
    vi.useFakeTimers();
    mocks.api.mockResolvedValue({ ok: true, data: { isAdmin: true }, status: 200 });
    render(await AuthorizedGallery());
    expect(screen.getByTestId("authorized-gallery")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries by refreshing the server route", () => {
    render(<GalleryRetry />);
    fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("keeps access checks dynamic and shows a loading boundary", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const route = DesignPage();
    expect(route.type).toBe(React.Suspense);
    expect(route.props.fallback.props.label).toBe("Checking gallery access");
  });
});
