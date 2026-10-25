import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildStudioBody } from "./BuildStudioPage";
import { navigation } from "../components/__tests__/navigationFixture";
import type { BuildDetail } from "./studioTypes";
const f = vi.hoisted(() => ({ call: vi.fn(), mutate: vi.fn(), detail: null as BuildDetail | null }));
vi.mock("next/navigation", async () => import("../components/__tests__/navigationFixture"));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "admin" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => null }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => f.call(...args), useApi: (url: string | null) => !url ? {} : { data: url.includes("?scope=") ? { items: [f.detail], nextAfter: null } : f.detail, mutate: f.mutate } }));
beforeEach(() => {
  navigation.defer = false; navigation.visit("/admin/build-studio"); f.call.mockReset(); f.mutate.mockReset();
  f.detail = { id: "PvZ - Archon Drop", name: "PvZ - Archon Drop", scope: "preset", owner: null, mode: "rule-only", expectedHash: "a".repeat(64), replacement: null, released: { implementation: "procedural", description: "Released reference" } };
  // The cache intentionally keeps returning the old revision. The save's
  // authoritative response must establish the new draft baseline immediately.
  f.mutate.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);
it("commits the returned draft before delayed cache acknowledgement and restores row focus after nested save", async () => {
  render(<BuildStudioBody />);
  const row = screen.getByRole("button", { name: /^PvZ - Archon Drop/ }); fireEvent.click(row);
  fireEvent.change(screen.getByLabelText("Reference description"), { target: { value: "Saved current reference" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Discard unsaved definition changes?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const review = screen.getByRole("dialog", { name: "Review definition changes" });
  f.call.mockImplementation(async (_token: unknown, _url: string, init: RequestInit) => ({ ...f.detail, replacement: JSON.parse(String(init.body)).replacement, expectedHash: "b".repeat(64), policyRevision: 4 }));
  fireEvent.click(within(review).getByRole("button", { name: "Confirm save" }));
  await screen.findByText("Definition saved as a new version.");
  expect((screen.getByLabelText("Reference description") as HTMLTextAreaElement).value).toBe("Saved current reference");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(row);
});
