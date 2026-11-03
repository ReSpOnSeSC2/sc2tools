import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimingsTable } from "../build/TimingsTable";
import { TimingsTableContent } from "../build/TimingsTableContent";
import { FIXTURE_BUILD_PUBLISHED, FIXTURE_ME } from "@/lib/guides/__fixtures__";
const h = vi.hoisted(() => ({ query: { isLoaded: true, isSignedIn: false, data: undefined as typeof FIXTURE_ME | undefined, error: undefined as unknown, isLoading: false }, suspended: undefined as Promise<void> | undefined }));
vi.mock("@/lib/guides/useGuideMe", () => ({ useGuideMe: () => { if (h.suspended) throw h.suspended; return h.query; } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.query }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/guides/pvz/stargate-into-glaives",
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => { cleanup(); h.query = { isLoaded: true, isSignedIn: false, data: undefined, error: undefined, isLoading: false }; h.suspended = undefined; });
const timings = { ...FIXTURE_BUILD_PUBLISHED.timings!, milestones: FIXTURE_BUILD_PUBLISHED.timings!.milestones.slice(0, 2).map((row, index) => ({ ...row, median: index ? 290 : 18, p25: index ? 280 : 17, p75: index ? 295 : 20 })) };
const table = () => <TimingsTable timings={timings} matchupSlug="pvz" buildSlug="stargate-into-glaives" community={<TimingsTableContent timings={timings} />} />;
const renderTable = async () => { const view = render(table()); await act(async () => { await vi.dynamicImportSettled(); }); return view; };

it("keeps signed-out server columns unchanged and offers a context-return sign-in link", async () => {
  await renderTable(); expect(screen.queryByRole("columnheader", { name: /^You/ })).toBeNull(); expect(screen.queryByLabelText("Loading your timing")).toBeNull(); expect(screen.getByRole("link", { name: "Sign in to see your own timings next to these" }).getAttribute("href")).toContain("redirect_url=%2Fguides%2Fpvz%2Fstargate-into-glaives");
});
it("shows a text-and-tone delta, a missing sample dash and a small-sample note", async () => {
  h.query = { ...h.query, isSignedIn: true, data: { ...FIXTURE_ME, timings: { samples: 2, milestones: [{ ...FIXTURE_ME.timings.milestones[0], key: timings.milestones[1].key, median: 302 }] } } };
  await renderTable(); expect(screen.getByRole("columnheader", { name: "You based on 2 of your games" })).toBeTruthy(); expect(screen.getByText("+12s · late").parentElement?.className).toContain("text-warning"); expect(screen.getByText("Your median is 12 seconds later than the community median, later than most players")).toBeTruthy();
  const rows = screen.getAllByRole("row").slice(1); expect(within(rows[0]).getAllByRole("cell").at(-1)?.textContent).toBe("—");
});
it("loads the You column only after signed-in auth resolves and hides it without any samples", async () => {
  h.query = { ...h.query, isLoaded: false, isLoading: true }; const view = await renderTable(); expect(screen.queryByRole("columnheader", { name: "You" })).toBeNull();
  h.query = { ...h.query, isLoaded: true, isSignedIn: true }; view.rerender(table()); expect(screen.getAllByLabelText("Loading your timing")).toHaveLength(2);
  h.query = { ...h.query, isLoading: false, data: { ...FIXTURE_ME, timings: { samples: 0, milestones: [] } } }; view.rerender(table()); expect(screen.queryByRole("columnheader", { name: "You" })).toBeNull();
});

it("retains the public table while auth is loading and after signing out", async () => {
  h.query = { ...h.query, isLoaded: false };
  const view = await renderTable();
  expect(screen.getByRole("region", { name: "Key timings table" }).tabIndex).toBe(0);
  expect(screen.getByRole("columnheader", { name: "Median" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Sign in to see your own timings next to these" })).toBeNull();
  h.query = { ...h.query, isLoaded: true, isSignedIn: true, data: FIXTURE_ME };
  view.rerender(table());
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(screen.getByRole("columnheader", { name: /^You/ })).toBeTruthy();
  h.query = { ...h.query, isSignedIn: false };
  view.rerender(table());
  expect(screen.queryByRole("columnheader", { name: /^You/ })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "Median" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in to see your own timings next to these" })).toBeTruthy();
});

it("uses the supplied public table while the lazy personal enhancement suspends", async () => {
  h.query = { ...h.query, isSignedIn: true, data: FIXTURE_ME };
  let release!: () => void;
  h.suspended = new Promise<void>((resolve) => { release = resolve; });
  try {
    await renderTable();
    expect(screen.getByRole("region", { name: "Key timings table" }).tabIndex).toBe(0);
    expect(screen.getByRole("columnheader", { name: "Median" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /^You/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in to see your own timings next to these" })).toBeNull();
  } finally {
    h.suspended = undefined;
    await act(async () => { release(); });
  }
});
