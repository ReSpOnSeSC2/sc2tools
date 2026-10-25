import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildStudioBody } from "./BuildStudioPage";
import { PolicyHistory } from "./PolicyHistory";
import { navigation } from "../components/__tests__/navigationFixture";

const f = vi.hoisted(() => ({ call: vi.fn(), urls: [] as string[], mutate: vi.fn(), forbidden: false }));
vi.mock("next/navigation", async () => import("../components/__tests__/navigationFixture"));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "admin" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => null }));
vi.mock("./BuildStudioEditor", () => ({ BuildStudioDetail: ({ scope, id }: { scope: string; id: string }) => <p>Opened {scope} definition {id}</p> }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => f.call(...args), useApi: (url: string | null) => {
  if (url) f.urls.push(url);
  if (!url) return {};
  if (f.forbidden) return { error: { status: 403 }, mutate: f.mutate };
  if (url.includes("/policy/history")) return { data: { items: [{ revision: 3, hash: "a".repeat(64), createdAt: "2026-10-23T12:00:00Z" }], nextBefore: 3 }, mutate: f.mutate };
  const params = new URLSearchParams(url.split("?")[1]); const scope = params.get("scope");
  return { data: { items: [{ id: params.has("after") ? "next-id" : "first-id", name: params.has("after") ? "Last private definition" : "First definition", scope, owner: scope === "preset" ? null : "owner-private", mode: scope === "preset" ? "procedural" : "rule-only", sourceSlug: scope === "community" ? "private-source" : undefined, removed: scope === "community" }], nextAfter: params.has("after") ? null : "cursor-two" }, mutate: f.mutate };
} }));
beforeEach(() => { navigation.defer = false; navigation.queued = []; navigation.visit("/admin/build-studio"); f.urls = []; f.forbidden = false; f.call.mockReset(); f.mutate.mockReset(); });
afterEach(cleanup);
it("traverses all-source keyset pages, keeps owner/source labels and opens the selected definition by native control", () => {
  render(<BuildStudioBody />);
  fireEvent.click(screen.getByRole("button", { name: "All private custom builds" }));
  expect(f.urls.at(-1)).toContain("scope=custom"); expect(screen.getByText(/Owner owner-private/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next definitions" }));
  expect(f.urls.at(-1)).toContain("after=cursor-two");
  fireEvent.click(screen.getByRole("button", { name: /Last private definition/ }));
  expect(screen.getByText("Opened custom definition next-id")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  fireEvent.click(screen.getByRole("button", { name: "All community snapshots" }));
  expect(screen.getByText(/private source private-source/)).toBeTruthy(); expect(screen.getByText(/removed listing/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Owner user ID (optional)"), { target: { value: "owner target" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply owner filter" })); expect(f.urls.at(-1)).toContain("owner=owner+target"); expect(f.urls.at(-1)).not.toContain("after=");
});
it("hides the catalog and editor behind the API admin role response", () => {
  f.forbidden = true; render(<BuildStudioBody />); expect(screen.getByText("403 — admin only")).toBeTruthy(); expect(screen.queryByRole("heading", { name: "Build Studio" })).toBeNull();
});
it("reviews the full historical policy and CAS hash before creating a new global revision", async () => {
  const policy = { schemaVersion: 1, evaluatorVersion: 1, revision: 4, hash: "c".repeat(64), entries: [{ name: "PvZ - Archon Drop", enabled: false, priority: 0, anyOf: [] }] };
  f.call.mockImplementation(async (_token, path: string, init?: RequestInit) => init ? { ...policy, revision: 5 } : path.includes("history/3") ? { ...policy, revision: 3, entries: [] } : policy);
  const changed = vi.fn(); render(<PolicyHistory onChanged={changed} />); fireEvent.click(screen.getByRole("button", { name: "Global preset policy history" }));
  fireEvent.click(screen.getByRole("button", { name: "Review revision 3" }));
  await screen.findByRole("dialog", { name: "Review global policy restore to revision 3" }); expect(f.call.mock.calls.every(call => !call[2])).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Confirm global restore" })); await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(f.call.mock.calls.at(-1)![2].body)).toEqual({ expectedHash: "c".repeat(64), revision: 3 });
  expect(screen.getByText("Policy restored as new revision 5.")).toBeTruthy();
});
it("restores the source through external history navigation", () => {
  render(<BuildStudioBody />); fireEvent.click(screen.getByRole("button", { name: "All private custom builds" }));
  act(() => navigation.visit("/admin/build-studio?scope=community")); expect(screen.getByRole("button", { name: "All community snapshots" }).getAttribute("aria-pressed")).toBe("true");
});
