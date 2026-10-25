import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockPollCard } from "../DockPollCard";
import { DockScenes } from "../DockScenes";
import { BuildProfileEditor } from "../BuildProfileEditor";
import { DockLazyPanel } from "../DockLazyPanel";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE, type StudioBuildProfile } from "@/lib/multichat/useStudioState";

const loaders = vi.hoisted(() => ({ loadBuildVote: vi.fn(), loadBrollLibrary: vi.fn(), loadBuildProfileChart: vi.fn() }));
vi.mock("../dockLazyLoaders", () => loaders);
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const onPost = async () => null;

it("retries a rejected build-picker import while retaining the selected mode and another panel's draft", async () => {
  loaders.loadBuildVote.mockRejectedValueOnce(new Error("Chunk 404")).mockResolvedValue(() => <p>Recovered build picker</p>);
  render(<><input aria-label="Unrelated draft" defaultValue="Keep this" /><DockPollCard token="fixture" poll={null} messages={[]} busy={false} studioReady onPost={onPost} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Build vote" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Build vote" }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByRole("textbox", { name: "Unrelated draft" }) as HTMLInputElement).value).toBe("Keep this");
  fireEvent.click(screen.getByRole("button", { name: "Retry build vote" }));
  expect(await screen.findByText("Recovered build picker")).toBeTruthy();
  expect(loaders.loadBuildVote).toHaveBeenCalledTimes(2);
});

it("contains a rejected b-roll import and retains the scene message through a fresh retry", async () => {
  loaders.loadBrollLibrary.mockRejectedValueOnce(new Error("Chunk 404")).mockResolvedValue(() => <p>Recovered b-roll manager</p>);
  render(<DockScenes scene={null} broll={DEFAULT_STUDIO_STATE.broll} busy={false} onPost={onPost} />);
  fireEvent.change(screen.getByPlaceholderText(/Optional message/), { target: { value: "Break draft" } });
  expect(loaders.loadBrollLibrary).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Manage b-roll" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "BRB" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry b-roll manager" }));
  expect(await screen.findByText("Recovered b-roll manager")).toBeTruthy();
  expect((screen.getByPlaceholderText(/Optional message/) as HTMLInputElement).value).toBe("Break draft");
  expect(loaders.loadBrollLibrary).toHaveBeenCalledTimes(2);
});

it("contains a graph render error and reruns its loader without losing edited ratings", async () => {
  loaders.loadBuildProfileChart.mockResolvedValueOnce(() => { throw new Error("Broken optional graph"); })
    .mockResolvedValue(({ profile }: { profile: StudioBuildProfile }) => <p>Recovered graph: {profile.title}</p>);
  const profile = { ...DEFAULT_BUILD_PROFILE, title: "Saved build", ratings: { aggressiveness: 4, defensiveness: 2, executionDifficulty: 3, popularity: 1, micro: 5 } };
  render(<BuildProfileEditor profile={profile} busy={false} onPost={onPost} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Unsaved title" } });
  const disclosure = screen.getByText("Preview graph").closest("details")!;
  disclosure.open = true; fireEvent(disclosure, new Event("toggle"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry build graph" }));
  expect(await screen.findByText("Recovered graph: Unsaved title")).toBeTruthy();
  expect(loaders.loadBuildProfileChart).toHaveBeenCalledTimes(2);
});

it("bounds a stalled optional load and lets Retry invoke a fresh factory", async () => {
  vi.useFakeTimers();
  const loader = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(() => <p>Recovered island</p>);
  render(<DockLazyPanel label="island" loader={loader} componentProps={{}} />);
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry island" })); });
  expect(screen.getByText("Recovered island")).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(2);
});
