import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommunityVotePanel } from "../CommunityVotePanel";
import { CommunityBuildReport } from "../CommunityBuildReport";

const mocks = vi.hoisted(() => ({ signedIn: true, apiCall: vi.fn(), useApi: vi.fn(), mutate: vi.fn(), data: { votes: 5, myVote: 1 } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: mocks.signedIn, userId: "reader", getToken: async () => "token" }), SignedIn: ({ children }: { children: ReactNode }) => mocks.signedIn ? children : null, SignedOut: ({ children }: { children: ReactNode }) => mocks.signedIn ? null : children }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: (...args: unknown[]) => mocks.apiCall(...args), useApi: (...args: unknown[]) => mocks.useApi(...args) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeEach(() => {
  mocks.signedIn = true; mocks.data = { votes: 5, myVote: 1 };
  mocks.apiCall.mockReset(); mocks.mutate.mockReset(); mocks.useApi.mockReset();
  sessionStorage.clear(); mocks.mutate.mockImplementation(async data => { if (data) mocks.data = data; return data; });
  mocks.useApi.mockImplementation(() => ({ data: mocks.data, isLoading: false, mutate: mocks.mutate }));
});
afterEach(cleanup);

it("seeds your saved vote, sends zero for the active toggle and uses the server score", async () => {
  mocks.apiCall.mockResolvedValue({ votes: 12, myVote: 0 });
  render(<CommunityVotePanel slug="macro" initialVotes={99} />);
  const up = screen.getByRole("button", { name: "Upvote" });
  expect(up.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Net score +5")).toBeTruthy();
  fireEvent.click(up);
  await waitFor(() => expect(screen.getByLabelText("Net score +12")).toBeTruthy());
  expect(JSON.parse(mocks.apiCall.mock.calls[0][2].body)).toEqual({ delta: 0 });
  expect(up.getAttribute("aria-pressed")).toBe("false");
});

it.each([[429, "You're voting too fast. Try again in a minute."], [401, "Your session expired. Sign in again."], [404, "This build was removed."]])("rolls back failed votes with an honest danger alert (%s)", async (status, message) => {
  mocks.apiCall.mockRejectedValue({ status }); render(<CommunityVotePanel slug="macro" initialVotes={5} />);
  fireEvent.click(screen.getByRole("button", { name: "Downvote" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
  expect(screen.getByRole("alert").className).toContain("text-danger");
  expect(screen.getByLabelText("Net score +5")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upvote" }).getAttribute("aria-pressed")).toBe("true");
});

it("ignores a second click while a vote is pending", async () => {
  mocks.apiCall.mockReturnValue(new Promise(() => {})); render(<CommunityVotePanel slug="macro" initialVotes={5} />);
  fireEvent.click(screen.getByRole("button", { name: "Downvote" })); fireEvent.click(screen.getByRole("button", { name: "Upvote" }));
  expect(mocks.apiCall).toHaveBeenCalledTimes(1);
});

it.each([true, false])("requires a report category, caps details, and follows alreadyReported=%s", async (alreadyReported) => {
  mocks.apiCall.mockResolvedValue({ alreadyReported }); render(<CommunityBuildReport slug="macro" />);
  fireEvent.click(screen.getByRole("button", { name: "Report" }));
  expect((screen.getByRole("button", { name: "Submit report" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Copied without credit" }));
  const note = screen.getByRole("textbox", { name: "Add details (optional)" });
  expect(note.getAttribute("maxlength")).toBe("280"); fireEvent.change(note, { target: { value: "a".repeat(300) } });
  expect(screen.getByText("280/280")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(alreadyReported ? "You've already reported this build — thanks." : "Thanks — a moderator will review this build."));
  expect(JSON.parse(mocks.apiCall.mock.calls[0][2].body)).toEqual({ targetType: "build", targetId: "macro", reason: "Copied without credit", note: "a".repeat(280) });
});

it("does not request a private vote signed out and keeps the build as the sign-in destination", () => {
  mocks.signedIn = false; render(<CommunityVotePanel slug="macro" initialVotes={5} />);
  expect(mocks.useApi).toHaveBeenCalledWith(null, undefined, { timeoutMs: 20_000 });
  expect(screen.getByRole("link", { name: "Sign in to vote" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fmacro");
});
