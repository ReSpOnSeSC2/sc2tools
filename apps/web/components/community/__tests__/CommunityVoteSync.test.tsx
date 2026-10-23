import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { CommunityVoteControls } from "../CommunityVoteControls";

const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "synthetic-token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ ...auth, isLoaded: true, isSignedIn: true, userId: "synthetic-reader" }), SignedIn: ({ children }: { children: ReactNode }) => children, SignedOut: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("deduplicates the private read and shares the authoritative vote across both layouts", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { votes: 12, myVote: -1 } : { votes: 5, myVote: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 10_000 }}><CommunityVoteControls slug="macro" initialVotes={0} /><CommunityVoteControls slug="macro" initialVotes={0} compact /></SWRConfig>);
  await waitFor(() => expect(screen.getAllByLabelText("Net score +5")).toHaveLength(2));
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole("button", { name: "Downvote" })[1]);
  await waitFor(() => expect(screen.getAllByLabelText("Net score +12")).toHaveLength(2));
  expect(screen.getAllByRole("button", { name: "Downvote" }).every((button) => button.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({ delta: -1 });
});
