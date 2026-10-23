import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SignInPage from "../../../app/sign-in/[[...rest]]/page";
import SignUpPage from "../../../app/sign-up/[[...rest]]/page";
import { LatestUpdate, latestPublicUpdate } from "../LatestUpdate";
const mocks = vi.hoisted(() => ({ redirect: "%2Ftry%3Fresume%3D1", count: vi.fn(), entries: [] as { id: string; title: string; date: string; audience: string }[] }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ redirect_url: mocks.redirect }) }));
vi.mock("@/lib/instant/localStore", () => ({ countTryGames: mocks.count }));
vi.mock("@/lib/whatsNew", () => ({ get WHATS_NEW() { return mocks.entries; } }));
vi.mock("@clerk/nextjs", () => ({
  SignUp: ({ forceRedirectUrl }: { forceRedirectUrl: string }) => <form aria-label="Sign up" data-redirect={forceRedirectUrl}><label>Email<input type="email" /></label></form>,
  SignIn: ({ forceRedirectUrl }: { forceRedirectUrl?: string }) => <form aria-label="Sign in" data-redirect={forceRedirectUrl}><label>Email<input type="email" /></label></form>,
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  mocks.redirect = "%2Ftry%3Fresume%3D1"; mocks.count.mockReset().mockResolvedValue(3); mocks.entries = [];
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
it.each([SignInPage, SignUpPage])("explains the local games being saved and preserves the safe redirect", async (Page) => {
  const { container } = render(<Page />);
  await screen.findByText("Your 3 analyzed games will be saved to your account. Replay files stay on your device.");
  expect(container.textContent).not.toMatch(/overlay URLs|Install the free Windows agent/);
  expect(screen.getByRole("form").getAttribute("data-redirect")).toBe("/try?resume=1");
  expect(mocks.count).toHaveBeenCalledTimes(1);
  expect(mocks.count.mock.calls[0][0]).toBeTypeOf("number");
});
it.each([[1, "Your 1 analyzed game will be saved to your account."], [0, "Sign in to keep analyzing."]])("handles count %s", async (count, text) => {
  mocks.count.mockResolvedValue(count); render(<SignUpPage />);
  await screen.findByText(`${text} Replay files stay on your device.`);
});
it("keeps truthful fallback copy when IndexedDB fails", async () => {
  mocks.count.mockRejectedValue(new Error("storage blocked")); render(<SignUpPage />);
  await waitFor(() => expect(mocks.count).toHaveBeenCalledOnce());
  expect(screen.getByText("Your analyzed games will be saved to your account. Replay files stay on your device.")).toBeTruthy();
});
it.each([SignInPage, SignUpPage])("keeps normal marketing without a try return and does not open IndexedDB", async (Page) => {
  mocks.redirect = "https://example.invalid"; const { container } = render(<Page />);
  await screen.findByRole("form");
  expect(container.textContent).toMatch(/overlay URLs|Install the free Windows agent/);
  expect(mocks.count).not.toHaveBeenCalled();
});
it("uses only the newest general-audience update, or renders no card", () => {
  expect(latestPublicUpdate([{ id: "agent", title: "Agent only", date: "2026-10-23", audience: "agent" }])).toBeUndefined();
  const { container, rerender } = render(<LatestUpdate />); expect(container.innerHTML).toBe("");
  mocks.entries = [{ id: "old", title: "Older", date: "2026-10-20", audience: "all" }, { id: "new", title: "Newest update", date: "2026-10-23", audience: "all" }];
  rerender(<LatestUpdate />);
  expect(screen.getByRole("link", { name: "Newest update" }).getAttribute("href")).toBe("/changelog#new");
  expect(screen.getByText("Oct 23, 2026")).toBeTruthy();
});
