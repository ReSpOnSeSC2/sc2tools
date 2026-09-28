import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, getToken: async (): Promise<string | null> => "token" },
  apiCall: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/clientApi", () => ({ apiCall: harness.apiCall, useApi: () => ({ data: { isAdmin: true } }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));

import { ReviewReplayDownload } from "../ReviewReplayDownload";
import { AskForReviewDialog } from "../AskForReviewButton";

const ID = "AAAAAAAAAAAAAAAA";

afterEach(() => cleanup());
beforeEach(() => {
  harness.auth = { isLoaded: true, isSignedIn: true, getToken: async () => "token" };
  harness.apiCall.mockReset();
  harness.push.mockReset();
});

describe("replay file download", () => {
  it("asks signed-out visitors to sign in, returning to the review", () => {
    harness.auth = { isLoaded: true, isSignedIn: false, getToken: async () => null };
    render(<ReviewReplayDownload requestId={ID} requestUrl={`/reviews/${ID}`} variant="page" />);
    const link = screen.getByRole("link", { name: "Sign in to download replay" });
    expect(link.getAttribute("href")).toBe(`/sign-in?redirect_url=${encodeURIComponent(`/reviews/${ID}`)}`);
  });

  it("fetches a fresh signed link on each click and starts the download", async () => {
    harness.apiCall.mockResolvedValue({ url: "https://replays.example.com/signed", filename: `sc2tools-review-${ID}.SC2Replay`, expiresIn: 300 });
    const clicks: HTMLAnchorElement[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    render(<ReviewReplayDownload requestId={ID} requestUrl={`/reviews/${ID}`} variant="page" />);
    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), `/v1/reviews/${ID}/replay`);
    expect(clicks[0].href).toBe("https://replays.example.com/signed");
    expect(clicks[0].download).toBe(`sc2tools-review-${ID}.SC2Replay`);
    spy.mockRestore();
  });

  it("refuses a non-https link and says why", async () => {
    harness.apiCall.mockResolvedValue({ url: "javascript:alert(1)", filename: "x", expiresIn: 1 });
    render(<ReviewReplayDownload requestId={ID} requestUrl={`/reviews/${ID}`} variant="page" />);
    fireEvent.click(screen.getByRole("button", { name: "Download replay" }));
    expect(await screen.findByText("The replay download link was invalid.")).toBeTruthy();
  });

  it("says when the file isn't uploaded yet (page) and hides on a card", () => {
    const { unmount } = render(<ReviewReplayDownload requestId={ID} requestUrl={`/reviews/${ID}`} variant="page" available={false} />);
    expect((screen.getByRole("button", { name: /Replay not uploaded yet/ }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const { container } = render(<ReviewReplayDownload requestId={ID} requestUrl={`/reviews/${ID}`} variant="card" available={false} />);
    expect(container.textContent).toBe("");
  });
});

describe("asking with the replay file shared", () => {
  it("is off by default; ticking it warns and sends shareReplay", async () => {
    harness.apiCall.mockResolvedValue({ id: ID, url: `/reviews/${ID}` });
    render(<AskForReviewDialog gameId="g1" durationSec={640} matchup="PvZ" onClose={() => {}} />);
    const box = screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(box);
    expect(screen.getByRole("note").textContent).toContain("both players");
    expect(screen.getByRole("note").textContent).toContain("chat");
    fireEvent.change(screen.getByRole("textbox", { name: /question/i }), { target: { value: "Why did my blink all-in fail against the roach defence?" } });
    fireEvent.click(screen.getByRole("button", { name: "Post request" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalled());
    const body = JSON.parse(harness.apiCall.mock.calls[0][2].body);
    expect(body).toMatchObject({ gameId: "g1", shareReplay: true, askerDisplay: "anonymous" });
    await waitFor(() => expect(harness.push).toHaveBeenCalledWith(`/reviews/${ID}`));
  });
});
