import type { ReactNode } from "react";
import Link from "next/link";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishPickerModal } from "./PublishPickerModal";
import type { CustomBuildPage } from "./useCustomBuildPage";

const h = vi.hoisted(() => ({
  data: { items: [] } as CustomBuildPage | undefined, error: undefined as Error | undefined,
  choose: vi.fn(), create: vi.fn(), close: vi.fn(), options: vi.fn(), mutate: vi.fn(), next: vi.fn(), previous: vi.fn(), reset: vi.fn(), hasNext: false,
}));
vi.mock("./useCustomBuildPage", () => ({ useCustomBuildPage: (query: unknown) => { h.options(query); return { data: h.data, error: h.error, mutate: h.mutate, resetPage: h.reset, hasNext: h.hasNext, hasPrevious: false, pageNumber: 1, pageStart: 0, pageSize: 50, nextPage: h.next, previousPage: h.previous }; } }));
vi.mock("@/components/community/useOwnerBuilds", () => ({ useOwnerBuilds: () => ({ data: { items: [{ sourceSlug: "published", removed: false }, { sourceSlug: "unpublished", removed: true }] } }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <Link href="/help/custom-builds">{children}</Link> }));
beforeEach(() => {
  h.data = { items: [{ slug: "published", name: "Safe macro", race: "Protoss", vsRace: "Zerg" }, { slug: "unpublished", name: "Old pressure", race: "Terran", vsRace: "Protoss" }], total: 2, libraryTotal: 2 };
  h.error = undefined; h.hasNext = false; for (const mock of [h.choose, h.create, h.close, h.options, h.mutate, h.next, h.previous, h.reset]) mock.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const view = () => render(<PublishPickerModal onClose={h.close} onChoose={h.choose} onCreate={h.create} />);

it("lists updated-order library builds and recognizes only active publications", () => {
  view(); expect(h.options).toHaveBeenCalledWith({ nameSearch: "", sort: "updated", view: "summary" });
  expect(screen.getByRole("heading", { name: "Pick a build to publish" })).toBeTruthy(); expect(screen.getAllByText("Published")).toHaveLength(1);
  expect(screen.getByText("PvZ")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Publish Safe macro" }));
  expect(h.choose).toHaveBeenCalledWith(expect.objectContaining({ slug: "published", isPublic: true }));
});

it("filters names after the debounce and keeps a bounded paginated list", async () => {
  vi.useFakeTimers(); h.hasNext = true; view();
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter by build name" }), { target: { value: "macro" } });
  await act(async () => vi.advanceTimersByTime(250)); expect(h.options).toHaveBeenLastCalledWith({ nameSearch: "macro", sort: "updated", view: "summary" });
  fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(h.next).toHaveBeenCalledTimes(1);
});

it("offers editor creation and help for a verified empty library", () => {
  h.data = { items: [], total: 0, libraryTotal: 0 }; view();
  expect(screen.getByText("You don't have any saved builds yet.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Learn how" }).getAttribute("href")).toBe("/help/custom-builds");
  fireEvent.click(screen.getByRole("button", { name: "Create a build" })); expect(h.close).toHaveBeenCalledTimes(1); expect(h.create).toHaveBeenCalledTimes(1);
});

it("retries unavailable data without claiming an empty library", () => {
  h.data = undefined; h.error = new Error("Unavailable"); view();
  expect(screen.queryByText("You don't have any saved builds yet.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(h.mutate).toHaveBeenCalledTimes(1);
});
