import { StrictMode, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { queuePendingIntent, readPendingIntent } from "@/lib/pendingIntent";
import { CommunityVoteControls } from "../CommunityVoteControls";
import { SaveToLibraryButton } from "../SaveToLibraryButton";

const env = vi.hoisted(() => ({ auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }, event: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => env.auth }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: env.event }));
const path = "/community/builds/macro";
const saved = (slug: string) => ({ slug, forkedFrom: { communitySlug: "macro" } });
const snapshot = { name: "Public macro", race: "Protoss" as const, vsRace: "Zerg" as const, signature: [], notes: "Public snapshot" };
const Save = () => <SaveToLibraryButton communitySlug="macro" title="Public macro" build={snapshot} />;
const votes = () => <><CommunityVoteControls slug="macro" initialVotes={3} /><CommunityVoteControls slug="macro" initialVotes={3} compact /></>;
function mount(children: ReactNode, strict = false) {
  const cache = new Map(); const tree = () => <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 10_000 }}>{children}</SWRConfig>;
  const view = render(strict ? <StrictMode>{tree()}</StrictMode> : tree());
  return { ...view, refresh: () => view.rerender(strict ? <StrictMode>{tree()}</StrictMode> : tree()) };
}
const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PUT" || init?.method === "POST");
const preventTestNavigation = (event: MouseEvent) => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); };
beforeEach(() => {
  document.addEventListener("click", preventTestNavigation);
  sessionStorage.clear(); history.replaceState({}, "", path); env.event.mockReset();
  env.auth.userId = "A"; env.auth.isLoaded = true; env.auth.isSignedIn = true; env.auth.getToken.mockReset().mockResolvedValue("jwt-A");
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => new Response(JSON.stringify(String(url).includes("my-vote") ? { votes: 3, myVote: 0 } : init?.method === "POST" ? { votes: 4, myVote: JSON.parse(String(init.body)).delta } : { items: [] }), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => { document.removeEventListener("click", preventTestNavigation); cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("signed-out save/sign-in links and each vote direction queue the exact public build action", () => {
  env.auth.userId = null; env.auth.isSignedIn = false; mount(<><Save />{votes()}</>);
  const signup = screen.getByRole("link", { name: "Sign up free to save this build" });
  fireEvent.click(signup); expect(readPendingIntent(path, "save-build")?.payload).toEqual({ slug: "macro" });
  fireEvent.click(screen.getByRole("link", { name: "Sign in" })); expect(readPendingIntent(path, "save-build")?.payload).toEqual({ slug: "macro" });
  fireEvent.click(screen.getAllByRole("link", { name: "Sign in to upvote" })[0]); expect(readPendingIntent(path, "vote")?.payload).toEqual({ slug: "macro", delta: 1 });
  fireEvent.click(screen.getAllByRole("link", { name: "Sign in to downvote" })[1]); expect(readPendingIntent(path, "vote")?.payload).toEqual({ slug: "macro", delta: -1 });
  expect(signup.getAttribute("href")).toContain(encodeURIComponent(path)); expect(fetch).not.toHaveBeenCalled();
});
it.each([1, -1] as const)("resumes vote %s once across StrictMode and both layouts, with shared success links", async delta => {
  queuePendingIntent("vote", { slug: "macro", delta }, path); mount(votes(), true);
  await waitFor(() => expect(screen.getAllByRole("link", { name: "View build" })).toHaveLength(2));
  expect(writes()).toHaveLength(1); expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ delta });
  expect(readPendingIntent(path, "vote")).toBeNull(); expect(env.event).toHaveBeenCalledWith("auth_intent_completed", { kind: "vote" });
});
it("does not toggle off an already-correct vote during resume", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ votes: 8, myVote: 1 }), { headers: { "content-type": "application/json" } }));
  queuePendingIntent("vote", { slug: "macro", delta: 1 }, path); mount(votes());
  await waitFor(() => expect(screen.getAllByRole("link", { name: "View build" })).toHaveLength(2)); expect(writes()).toHaveLength(0);
  expect(screen.getAllByRole("button", { name: "Upvote" }).every(node => node.getAttribute("aria-pressed") === "true")).toBe(true);
});
it("keeps another path's intent untouched", async () => {
  queuePendingIntent("vote", { slug: "other", delta: 1 }, "/community/builds/other"); mount(votes());
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Upvote" })[0]).toHaveProperty("disabled", false));
  expect(writes()).toHaveLength(0); expect(readPendingIntent("/community/builds/other", "vote")).not.toBeNull();
});
it("does not consume a pending vote until its authoritative read recovers", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Busy" } }), { status: 503 }));
  queuePendingIntent("vote", { slug: "macro", delta: 1 }, path); mount(<CommunityVoteControls slug="macro" initialVotes={3} />);
  await screen.findByRole("button", { name: "Retry voting" }); expect(screen.getByRole("button", { name: "Upvote" })).toHaveProperty("disabled", true);
  expect(writes()).toHaveLength(0); expect(readPendingIntent(path, "vote")).not.toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry voting" }));
  await screen.findByRole("link", { name: "View build" }); expect(writes()).toHaveLength(1);
});
it("does not consume another build payload even when its stored path matches", async () => {
  queuePendingIntent("vote", { slug: "other", delta: 1 }, path); mount(votes());
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Upvote" })[0]).toHaveProperty("disabled", false));
  expect(writes()).toHaveLength(0); expect(readPendingIntent(path, "vote")?.payload.slug).toBe("other");
});
it("automatically saves the current public snapshot once, sharing the owner library link", async () => {
  queuePendingIntent("save-build", { slug: "macro" }, path); mount(<><Save /><Save /></>, true);
  await waitFor(() => expect(screen.getAllByRole("link", { name: "In your library — Open" })).toHaveLength(2));
  expect(writes()).toHaveLength(1); const body = JSON.parse(String(writes()[0][1]?.body));
  expect(body).toMatchObject({ name: "Public macro", notes: "Public snapshot", createOnly: true, forkedFrom: { communitySlug: "macro" } });
  expect(screen.getAllByRole("link", { name: "In your library — Open" })[0].getAttribute("href")).toBe(`/builds/${body.slug}`);
});
it("uses the fresh authenticated owner's existing copy without another PUT", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [saved("owned-existing")] }), { headers: { "content-type": "application/json" } }));
  queuePendingIntent("save-build", { slug: "macro" }, path); mount(<Save />);
  await waitFor(() => expect(env.event).toHaveBeenCalledWith("auth_intent_completed", { kind: "save-build" }));
  expect(screen.getByRole("link", { name: "In your library — Open" }).getAttribute("href")).toBe("/builds/owned-existing"); expect(writes()).toHaveLength(0);
});
it("does not automatically create a duplicate when the fresh lookup fails", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unavailable" } }), { status: 503 }));
  queuePendingIntent("save-build", { slug: "macro" }, path); mount(<Save />);
  await screen.findByRole("alert"); expect(writes()).toHaveLength(0); expect(env.event).not.toHaveBeenCalledWith("auth_intent_completed", expect.anything());
});
it("rejects malformed fresh lookup data before an automatic save", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } })).mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: "not a library response" }), { headers: { "content-type": "application/json" } }));
  queuePendingIntent("save-build", { slug: "macro" }, path); mount(<Save />);
  await screen.findByRole("alert"); expect(writes()).toHaveLength(0);
});
it("cancels a resumed vote's held JWT when auth becomes loading", async () => {
  let finish!: (value: string) => void; env.auth.getToken.mockResolvedValueOnce("jwt-A").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  queuePendingIntent("vote", { slug: "macro", delta: 1 }, path); const view = mount(votes());
  await waitFor(() => expect(finish).toBeTypeOf("function")); env.auth.isLoaded = false; view.refresh();
  await act(async () => finish("late-A")); expect(writes()).toHaveLength(0); expect(env.event).not.toHaveBeenCalledWith("auth_intent_completed", expect.anything());
});
it("fences original manual vote token resolution through A→B→A", async () => {
  const view = mount(<CommunityVoteControls slug="macro" initialVotes={3} />); await waitFor(() => expect(screen.getByRole("button", { name: "Upvote" })).toHaveProperty("disabled", false));
  let finish!: (value: string) => void; env.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Upvote" })); env.auth.userId = "B"; view.refresh(); env.auth.userId = "A"; view.refresh();
  await act(async () => finish("late-A")); expect(writes()).toHaveLength(0);
});
it("fences the original manual save after a held lookup body and account change", async () => {
  const view = mount(<Save />); await waitFor(() => expect(screen.getByRole("button", { name: "Save to my library" })).toHaveProperty("disabled", false));
  let finish!: (value: unknown) => void; vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  fireEvent.click(screen.getByRole("button", { name: "Save to my library" })); await waitFor(() => expect(finish).toBeTypeOf("function"));
  env.auth.userId = "B"; env.auth.getToken.mockResolvedValue("jwt-B"); view.refresh();
  await act(async () => finish({ items: [saved("private-A")] })); expect(writes()).toHaveLength(0); expect(screen.queryByRole("link", { name: "In your library — Open" })).toBeNull();
});
it("ignores a late original save body after switching accounts", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(fetch).mockImplementation(async (_url: unknown, init?: RequestInit) => init?.method === "PUT" ? ({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as Response) : new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } }));
  const view = mount(<Save />); await waitFor(() => expect(screen.getByRole("button", { name: "Save to my library" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Save to my library" })); await waitFor(() => expect(finish).toBeTypeOf("function"));
  env.auth.userId = "B"; env.auth.getToken.mockResolvedValue("jwt-B"); view.refresh(); await act(async () => finish({ ok: true }));
  expect(screen.queryByRole("link", { name: "In your library — Open" })).toBeNull(); await waitFor(() => expect(screen.getByRole("button", { name: "Save to my library" })).toHaveProperty("disabled", false));
});
it("a held manual save JWT reaches its deadline and allows a new attempt", async () => {
  mount(<Save />); await waitFor(() => expect(screen.getByRole("button", { name: "Save to my library" })).toHaveProperty("disabled", false));
  vi.useFakeTimers(); let finish!: (value: string) => void; env.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Save to my library" })); await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(screen.getByRole("button", { name: "Save to my library" })).toHaveProperty("disabled", false); expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => finish("late-A")); expect(writes()).toHaveLength(0);
  vi.useRealTimers(); fireEvent.click(screen.getByRole("button", { name: "Save to my library" })); await screen.findByRole("link", { name: "In your library — Open" }); expect(writes()).toHaveLength(1);
});
