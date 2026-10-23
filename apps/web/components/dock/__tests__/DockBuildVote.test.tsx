import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockPollCard } from "../DockPollCard";
import { DEFAULT_STUDIO_STATE, type StudioPoll } from "@/lib/multichat/useStudioState";
const builds = [
  { slug: "macro", name: "Macro", race: "T", vsRace: "Z", total: 10, winRate: 0.7 },
  { slug: "pressure", name: "Pressure", race: "T", vsRace: "Z", total: 4, winRate: 0.5 },
  { slug: "blink", name: "Blink", race: "P", vsRace: "T", total: 0, winRate: null },
];
const fetcher = vi.fn();
const onPost = vi.fn(async () => DEFAULT_STUDIO_STATE);
function panel(poll: StudioPoll | null = null, ready = true) {
  return render(<DockPollCard token="token" poll={poll} messages={[{ platform: "twitch", id: "vote", user: "viewer", text: "2", badges: [], atMs: 5 }]} busy={false} studioReady={ready} onPost={onPost} />);
}
beforeEach(() => { onPost.mockClear(); fetcher.mockReset().mockResolvedValue({ ok: true, json: async () => ({ builds }) }); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("mounts the saved-build vote, filters actual matchups and starts selected builds", async () => {
  panel();
  expect(screen.getByRole("button", { name: "Custom poll" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Build vote" }));
  await screen.findByRole("button", { name: /Macro/ });
  const matchups = screen.getByRole("group", { name: "Build matchups" });
  expect(within(matchups).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "TvZ", "PvT"]);
  fireEvent.click(within(matchups).getByRole("button", { name: "TvZ" }));
  expect(screen.queryByRole("button", { name: /Blink/ })).toBeNull();
  for (const name of [/Macro/, /Pressure/]) {
    const button = screen.getByRole("button", { name }); fireEvent.click(button); expect(button.getAttribute("aria-pressed")).toBe("true");
  }
  fireEvent.click(screen.getByRole("button", { name: "Start build vote" }));
  await waitFor(() => expect(onPost).toHaveBeenCalledWith({ poll: { question: "Chat picks the build!", options: ["Macro", "Pressure"], status: "open", meta: { kind: "build", winRates: { Macro: 70, Pressure: 50 } } } }, expect.any(Function)));
});
it("locks to the saved build-poll mode and links the closed winner", async () => {
  panel({ question: "Build?", options: ["Macro", "Pressure"], startedAtMs: 1, status: "closed", meta: { kind: "build", winRates: {} } });
  expect((screen.getByRole("button", { name: "Custom poll" }) as HTMLButtonElement).disabled).toBe(true);
  const link = await screen.findByRole("link", { name: /Open build/ });
  expect(screen.getByText("Pressure", { selector: "b" })).toBeTruthy();
  expect(link.getAttribute("href")).toBe("/builds/pressure"); expect(link.getAttribute("target")).toBe("_blank"); expect(link.getAttribute("rel")).toContain("noopener");
});
it("distinguishes retryable fetch failures from a genuinely empty build library", async () => {
  fetcher.mockResolvedValueOnce({ ok: false }); panel(); fireEvent.click(screen.getByRole("button", { name: "Build vote" }));
  await screen.findByRole("alert"); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ builds: [] }) });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: "Builds" })).toBeTruthy(); expect(screen.getByText(/No saved builds yet/)).toBeTruthy();
});
it("keeps controls gated until the authoritative snapshot is ready", async () => {
  panel(null, false); await act(async () => {});
  expect((screen.getByRole("button", { name: "Build vote" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onPost).not.toHaveBeenCalled();
});

it("keeps the closed winner stable when later chat arrives", async () => {
  const open: StudioPoll = { question: "Build?", options: ["Macro", "Pressure"], startedAtMs: 1, status: "open", meta: { kind: "build", winRates: {} } };
  const votes = [{ platform: "twitch" as const, id: "vote", user: "viewer", text: "2", badges: [], atMs: 5 }];
  const view = render(<DockPollCard token="token" poll={open} messages={votes} busy={false} studioReady onPost={onPost} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const closed = { ...open, status: "closed" as const };
  view.rerender(<DockPollCard token="token" poll={closed} messages={votes} busy={false} studioReady onPost={onPost} />);
  await screen.findByRole("link", { name: /Open build/ });
  view.rerender(<DockPollCard token="token" poll={closed} messages={[...votes, ...["a", "b"].map((user) => ({ ...votes[0], id: user, user, text: "1" }))]} busy={false} studioReady onPost={onPost} />);
  expect(screen.getByRole("link", { name: /Open build/ }).getAttribute("href")).toBe("/builds/pressure");
});
