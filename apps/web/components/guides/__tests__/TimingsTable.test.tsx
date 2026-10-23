import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimingsTable } from "../build/TimingsTable";
import { FIXTURE_BUILD_PUBLISHED, FIXTURE_ME } from "@/lib/guides/__fixtures__";
const h = vi.hoisted(() => ({ query: { isLoaded: true, isSignedIn: false, data: undefined as typeof FIXTURE_ME | undefined, error: undefined as unknown, isLoading: false } }));
vi.mock("@/lib/guides/useGuideMe", () => ({ useGuideMe: () => h.query }));
vi.mock("next/navigation", () => ({ usePathname: () => "/guides/pvz/stargate-into-glaives" }));
afterEach(() => { cleanup(); h.query = { isLoaded: true, isSignedIn: false, data: undefined, error: undefined, isLoading: false }; });
const timings = { ...FIXTURE_BUILD_PUBLISHED.timings!, milestones: FIXTURE_BUILD_PUBLISHED.timings!.milestones.slice(0, 2).map((row, index) => ({ ...row, median: index ? 290 : 18, p25: index ? 280 : 17, p75: index ? 295 : 20 })) };
const renderTable = () => render(<TimingsTable timings={timings} matchupSlug="pvz" buildSlug="stargate-into-glaives" />);

it("keeps signed-out server columns unchanged and offers a context-return sign-in link", () => {
  renderTable(); expect(screen.queryByRole("columnheader", { name: /^You/ })).toBeNull(); expect(screen.queryByLabelText("Loading your timing")).toBeNull(); expect(screen.getByRole("link", { name: "Sign in to see your own timings next to these" }).getAttribute("href")).toContain("redirect_url=%2Fguides%2Fpvz%2Fstargate-into-glaives");
});
it("shows a text-and-tone delta, a missing sample dash and a small-sample note", () => {
  h.query = { ...h.query, isSignedIn: true, data: { ...FIXTURE_ME, timings: { samples: 2, milestones: [{ ...FIXTURE_ME.timings.milestones[0], key: timings.milestones[1].key, median: 302 }] } } };
  renderTable(); expect(screen.getByRole("columnheader", { name: "You based on 2 of your games" })).toBeTruthy(); expect(screen.getByText("+12s · late").parentElement?.className).toContain("text-warning"); expect(screen.getByText("Your median is 12 seconds later than the community median, later than most players")).toBeTruthy();
  const rows = screen.getAllByRole("row").slice(1); expect(within(rows[0]).getAllByRole("cell").at(-1)?.textContent).toBe("—");
});
it("loads the You column only after signed-in auth resolves and hides it without any samples", () => {
  h.query = { ...h.query, isLoaded: false, isLoading: true }; const view = renderTable(); expect(screen.queryByRole("columnheader", { name: "You" })).toBeNull();
  h.query = { ...h.query, isLoaded: true, isSignedIn: true }; view.rerender(<TimingsTable timings={timings} matchupSlug="pvz" buildSlug="stargate-into-glaives" />); expect(screen.getAllByLabelText("Loading your timing")).toHaveLength(2);
  h.query = { ...h.query, isLoading: false, data: { ...FIXTURE_ME, timings: { samples: 0, milestones: [] } } }; view.rerender(<TimingsTable timings={timings} matchupSlug="pvz" buildSlug="stargate-into-glaives" />); expect(screen.queryByRole("columnheader", { name: "You" })).toBeNull();
});
