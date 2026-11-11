import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AdminEvent } from "./adminTypes";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "fixture-token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));
import { ToastProvider } from "@/components/ui/Toast";
import { AdminEventRow } from "./AdminEventRow";

afterEach(cleanup);

const signup: AdminEvent = {
  eventId: "signup-1", type: "user_signup", createdAt: "2026-10-23T12:00:00Z", readAt: null,
  payload: { clerkUserId: "clerk-1", userId: "account/one", email: "new@example.test", source: "first_touch" },
};
const download: AdminEvent = {
  eventId: "download-1", type: "agent_download", createdAt: "2026-10-23T12:00:00Z", readAt: null,
  payload: { platform: "windows", version: "0.24.0", channel: "stable", ip: null, userAgent: null, referer: null, country: null },
};

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const wrap = (node: ReactNode) => <ToastProvider><ul>{node}</ul></ToastProvider>;

describe("per-row read state", () => {
  it("marks read optimistically, keeps it after success, and follows the row's data afterwards", async () => {
    const save = deferred();
    const onSetRead = vi.fn(() => save.promise);
    const { container, rerender } = render(wrap(<AdminEventRow event={signup} unread onSetRead={onSetRead} />));
    const toggle = screen.getByRole("button", { name: "Mark as read: New signup" });
    fireEvent.click(toggle);
    expect(onSetRead).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Mark as unread: New signup" }).getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("li")?.className).not.toContain("bg-accent-cyan");
    await act(async () => { save.resolve(); });
    expect(screen.getByRole("button", { name: "Mark as unread: New signup" }).getAttribute("aria-busy")).toBeNull();
    rerender(wrap(<AdminEventRow event={{ ...signup, readAt: "2026-10-23T13:00:00Z" }} unread={false} onSetRead={onSetRead} />));
    rerender(wrap(<AdminEventRow event={signup} unread onSetRead={onSetRead} />));
    expect(screen.getByRole("button", { name: "Mark as read: New signup" })).toBeTruthy();
  });

  it("rolls back a failed save and offers Retry, which saves the same change again", async () => {
    const onSetRead = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(wrap(<AdminEventRow event={download} unread={false} onSetRead={onSetRead} />));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Mark as unread: Agent download/ })); });
    expect(onSetRead).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: /^Mark as unread: Agent download/ })).toBeTruthy();
    const toast = screen.getByRole("alert");
    expect(toast.textContent).toContain("Couldn't mark as unread");
    await act(async () => { fireEvent.click(within(toast).getByRole("button", { name: "Retry" })); });
    expect(onSetRead).toHaveBeenCalledTimes(2);
    expect(onSetRead).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: /^Mark as read: Agent download/ })).toBeTruthy();
  });

  it("the failed control stays visible; otherwise it reveals on hover, focus and touch", async () => {
    const onSetRead = vi.fn().mockRejectedValue(new Error("offline"));
    render(wrap(<AdminEventRow event={download} unread onSetRead={onSetRead} />));
    const toggle = screen.getByRole("button", { name: /^Mark as read/ });
    expect(toggle.className).toContain("opacity-0");
    expect(toggle.className).toContain("group-focus-within/event:opacity-100");
    expect(toggle.className).toContain("[@media(hover:none)]:opacity-100");
    await act(async () => { fireEvent.click(toggle); });
    expect(screen.getByRole("button", { name: /^Mark as read/ }).className).not.toContain("opacity-0");
  });

  it("offers Open user beside the row only for a linked, live account; no control without onSetRead", () => {
    const { rerender } = render(wrap(<AdminEventRow event={signup} unread />));
    expect(screen.getByRole("link", { name: "Open user" }).getAttribute("href")).toBe("/admin/users/account%2Fone");
    expect(screen.queryByRole("button", { name: /^Mark as/ })).toBeNull();
    rerender(wrap(<AdminEventRow event={{ ...signup, anonymizedAt: "2026-10-24T00:00:00Z" }} unread />));
    expect(screen.queryByRole("link", { name: "Open user" })).toBeNull();
    rerender(wrap(<AdminEventRow event={download} unread />));
    expect(screen.queryByRole("link", { name: "Open user" })).toBeNull();
    rerender(wrap(<AdminEventRow event={signup} unread compact onSetRead={vi.fn()} />));
    expect(screen.queryByRole("link", { name: "Open user" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mark as/ })).toBeNull();
  });
});
