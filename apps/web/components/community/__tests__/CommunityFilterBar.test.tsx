import type { ReactNode } from "react";
import Link from "next/link";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ replace: vi.fn(), query: "", pending: false }));
vi.mock("next/navigation", () => ({ useRouter: () => h, useSearchParams: () => new URLSearchParams(h.query) }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useTransition: () => [h.pending, (action: () => void) => action()] }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <Link href="/help/community-builds#sorting">{children}</Link> }));

import { CommunityFilterBar, type CommunityFilterBarProps } from "../CommunityFilterBar";
import { CommunityFilterProvider, CommunityResults } from "../CommunityFilterContext";
import { CommunityActiveFilters } from "../CommunityActiveFilters";
import { parseCommunityQuery } from "@/lib/communityQuery";

const defaults: CommunityFilterBarProps = { initialRace: "", initialVs: "", initialSkill: "", initialSort: "top", initialSearch: "" };
const View = ({ props }: { props: CommunityFilterBarProps }) => <CommunityFilterProvider><CommunityFilterBar {...props} /><CommunityResults><p>Build results</p></CommunityResults></CommunityFilterProvider>;
beforeEach(() => { h.replace.mockReset(); h.query = ""; h.pending = false; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("resets a URL-driven search without remounting or losing the focused input", () => {
  h.query = "q=roach";
  const { rerender } = render(<View props={{ ...defaults, initialSearch: "roach" }} />);
  const input = screen.getByRole("searchbox", { name: "Search community builds" }); input.focus();
  h.query = ""; rerender(<View props={defaults} />);
  expect((input as HTMLInputElement).value).toBe(""); expect(document.activeElement).toBe(input);
  expect(screen.getByRole("searchbox")).toBe(input);
});

it("does not clobber typing with stale props or its own earlier URL acknowledgement", async () => {
  h.query = "q=roach";
  const { rerender } = render(<View props={{ ...defaults, initialSearch: "roach" }} />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "roachlings" } }); rerender(<View props={{ ...defaults, initialSearch: "roach" }} />);
  expect((input as HTMLInputElement).value).toBe("roachlings");
  await act(async () => vi.advanceTimersByTime(300)); expect(h.replace).toHaveBeenLastCalledWith("/community?q=roachlings", { scroll: false });
  fireEvent.change(input, { target: { value: "roachlings more" } }); h.query = "q=roachlings";
  rerender(<View props={{ ...defaults, initialSearch: "roachlings" }} />);
  expect((input as HTMLInputElement).value).toBe("roachlings more");
});

it("restores search on Back and Forward after clearing it", async () => {
  h.query = "q=roach"; const { rerender } = render(<View props={{ ...defaults, initialSearch: "roach" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" })); await act(async () => vi.advanceTimersByTime(300));
  h.query = ""; rerender(<View props={defaults} />);
  h.query = "q=roach"; rerender(<View props={{ ...defaults, initialSearch: "roach" }} />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("roach");
  h.query = ""; rerender(<View props={defaults} />); expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});

it("writes race, vs and skill while retaining the current search/sort and dropping pagination", () => {
  h.query = "vs=T&skill=diamond&sort=updated&q=roach&offset=48";
  render(<View props={{ ...defaults, initialVs: "T", initialSkill: "diamond", initialSort: "updated", initialSearch: "roach" }} />);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "My race" })).getByRole("radio", { name: "Zerg" }));
  expect(h.replace).toHaveBeenLastCalledWith("/community?race=Z&vs=T&skill=diamond&sort=updated&q=roach", { scroll: false });
  fireEvent.change(screen.getByRole("combobox", { name: "Skill level" }), { target: { value: "master" } });
  expect(h.replace).toHaveBeenLastCalledWith("/community?vs=T&skill=master&sort=updated&q=roach", { scroll: false });
  expect(screen.getByRole("option", { name: "Recently updated" })).toBeTruthy();
});

it("uses the shared roving radio control, including arrow keys, with one Tab stop per group", () => {
  render(<View props={defaults} />); const group = screen.getByRole("radiogroup", { name: "My race" });
  const radios = within(group).getAllByRole("radio"); expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  fireEvent.keyDown(radios[0], { key: "ArrowRight" }); expect(document.activeElement).toBe(radios[1]);
  expect(h.replace).toHaveBeenLastCalledWith("/community?race=P", { scroll: false });
  fireEvent.keyDown(radios[1], { key: "End" }); expect(h.replace).toHaveBeenLastCalledWith("/community?race=Z", { scroll: false });
});

it("shares transition feedback with results and replaces the clear button with a motion-safe spinner", () => {
  const { rerender } = render(<View props={{ ...defaults, initialSearch: "roach" }} />);
  expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  h.pending = true; rerender(<View props={{ ...defaults, initialSearch: "roach" }} />);
  expect(screen.getByRole("region", { name: "Community build results" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status", { name: "Updating community builds" }).querySelector("svg")?.classList.contains("motion-safe:animate-spin")).toBe(true);
  expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  h.pending = false; rerender(<View props={{ ...defaults, initialSearch: "roach" }} />);
  expect(screen.getByRole("region").getAttribute("aria-busy")).toBeNull();
});

it("clears active filters while keeping the sort, and leaves slash available to global search", () => {
  const query = parseCommunityQuery({ race: "Z", vs: "T", skill: "diamond", sort: "updated", q: "roach", offset: "48" });
  render(<><View props={defaults} /><CommunityActiveFilters query={query} /></>);
  expect(screen.getByRole("link", { name: "Clear all" }).getAttribute("href")).toBe("/community?sort=updated");
  expect(screen.getByRole("link", { name: "Remove filter vs Terran" }).getAttribute("href")).toBe("/community?race=Z&skill=diamond&sort=updated&q=roach");
  fireEvent.keyDown(document.body, { key: "/" }); expect(document.activeElement).not.toBe(screen.getByRole("searchbox"));
});
