import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "viewer-a", getToken: async (): Promise<string | null> => "token" },
  me: { isAdmin: false },
  apiCall: vi.fn(),
  useApi: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/clientApi", async (original) => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: harness.apiCall, useApi: harness.useApi }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));

import { AskForReviewButton, AskForReviewDialog, parseRange } from "../AskForReviewButton";
import { parseClock } from "@/lib/reviews";

const ID = "AAAAAAAAAAAAAAAA";
const QUESTION = "Why did my blink all-in fail against the roach defence?";
const PROPS = { gameId: "g1", durationSec: 640, matchup: "PvZ" };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
  harness.auth = { isLoaded: true, isSignedIn: true, userId: "viewer-a", getToken: async () => "token" };
  harness.me = { isAdmin: false };
  harness.useApi.mockReset().mockImplementation(() => ({ data: harness.me }));
  harness.apiCall.mockReset().mockResolvedValue({ id: ID, url: `/reviews/${ID}` });
  harness.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function fillQuestion(value = QUESTION) {
  fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value } });
}

function submitForm() {
  fireEvent.submit(screen.getByRole("textbox", { name: "Your question" }).closest("form")!);
}

describe("AskForReviewButton", () => {
  it("respects sign-in and rollout visibility, fetching admin status only when needed", () => {
    const { rerender } = render(<AskForReviewButton {...PROPS} />);
    expect(screen.getByRole("button", { name: "Ask for a review" })).toBeTruthy();
    expect(harness.useApi).toHaveBeenLastCalledWith(null);

    harness.auth.isSignedIn = false;
    rerender(<AskForReviewButton {...PROPS} />);
    expect(screen.queryByRole("button", { name: "Ask for a review" })).toBeNull();
    harness.auth.isSignedIn = true;
    harness.auth.isLoaded = false;
    rerender(<AskForReviewButton {...PROPS} />);
    expect(screen.queryByRole("button", { name: "Ask for a review" })).toBeNull();

    harness.auth.isLoaded = true;
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "off");
    rerender(<AskForReviewButton {...PROPS} />);
    expect(screen.queryByRole("button", { name: "Ask for a review" })).toBeNull();
    expect(harness.useApi).toHaveBeenLastCalledWith(null);

    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "admins");
    rerender(<AskForReviewButton {...PROPS} />);
    expect(screen.queryByRole("button", { name: "Ask for a review" })).toBeNull();
    expect(harness.useApi).toHaveBeenLastCalledWith("/v1/me");
    harness.me.isAdmin = true;
    rerender(<AskForReviewButton {...PROPS} />);
    expect(screen.getByRole("button", { name: "Ask for a review" })).toBeTruthy();
  });

  it("keeps the button and portalled dialog events out of clickable replay rows", () => {
    const rowClick = vi.fn();
    const rowPointer = vi.fn();
    render(<div onClick={rowClick} onPointerDown={rowPointer}><AskForReviewButton {...PROPS} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Ask for a review" }));
    const input = screen.getByRole("textbox", { name: "Your question" });
    fireEvent.pointerDown(input);
    fireEvent.click(input);
    fireEvent.click(screen.getByRole("button", { name: "Macro" }));
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowPointer).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog before navigating to the newly posted request", async () => {
    render(<AskForReviewButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask for a review" }));
    fillQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Post request" }));
    await waitFor(() => expect(harness.push).toHaveBeenCalledWith(`/reviews/${ID}`));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discards a draft and sharing consent when the signed-in account changes", () => {
    const { rerender } = render(<AskForReviewButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask for a review" }));
    fillQuestion();
    fireEvent.click(screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }));
    harness.auth.userId = "viewer-b";
    rerender(<AskForReviewButton {...PROPS} />);
    expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("AskForReviewDialog", () => {
  it("posts the API contract with private defaults and closes before navigation", async () => {
    const onClose = vi.fn();
    render(<AskForReviewDialog {...PROPS} onClose={onClose} />);
    fillQuestion(`  ${QUESTION}  `);
    fireEvent.click(screen.getByRole("button", { name: "Post request" }));
    await waitFor(() => expect(harness.push).toHaveBeenCalledWith(`/reviews/${ID}`));
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(harness.push.mock.invocationCallOrder[0]);
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/reviews");
    expect(JSON.parse(init.body)).toEqual({
      gameId: "g1", question: QUESTION, tags: [], timeRange: null,
      desiredLevel: "anyone", visibility: "public", askerDisplay: "anonymous", shareReplay: false,
    });
  });

  it("posts selected focus, range, audience, visibility, name and replay-sharing consent", async () => {
    render(<AskForReviewDialog {...PROPS} onClose={vi.fn()} />);
    fillQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Macro" }));
    fireEvent.click(screen.getByRole("button", { name: "Scouting" }));
    fireEvent.change(screen.getByLabelText("From (m:ss)"), { target: { value: "5:00" } });
    fireEvent.change(screen.getByLabelText("To (m:ss)"), { target: { value: "6:30" } });
    fireEvent.change(screen.getByLabelText("Who should review"), { target: { value: "masters_plus" } });
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "link" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Show my display name/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }));
    expect(screen.getByRole("note").textContent).toMatch(/both players.*chat/s);
    submitForm();
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledOnce());
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toMatchObject({
      tags: ["macro", "scouting"], timeRange: { startSec: 300, endSec: 390 },
      desiredLevel: "masters_plus", visibility: "link", askerDisplay: "named", shareReplay: true,
    });
  });

  it("validates the question and associates invalid range feedback with both inputs", () => {
    render(<AskForReviewDialog {...PROPS} onClose={vi.fn()} />);
    fillQuestion("Too short");
    submitForm();
    expect(screen.getByText(/at least 20 characters/)).toBeTruthy();
    expect(harness.apiCall).not.toHaveBeenCalled();
    fillQuestion();
    const start = screen.getByLabelText("From (m:ss)");
    const end = screen.getByLabelText("To (m:ss)");
    fireEvent.change(start, { target: { value: "10:30" } });
    fireEvent.change(end, { target: { value: "11:00" } });
    submitForm();
    const feedback = screen.getByRole("alert");
    expect(feedback.textContent).toBe("The range must sit inside the game.");
    expect(start.getAttribute("aria-describedby")?.split(" ")).toContain(feedback.id);
    expect(end.getAttribute("aria-describedby")?.split(" ")).toContain(feedback.id);
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("prevents repeated form submissions while a request is pending", async () => {
    let resolve!: (value: { id: string; url: string }) => void;
    harness.apiCall.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AskForReviewDialog {...PROPS} onClose={vi.fn()} />);
    fillQuestion();
    submitForm();
    submitForm();
    expect(harness.apiCall).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Post request" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve({ id: ID, url: `/reviews/${ID}` }); });
    expect(harness.push).toHaveBeenCalledOnce();
  });

  it("keeps the draft after an API error and clears duplicate recovery advice for a retry", async () => {
    harness.apiCall.mockRejectedValueOnce({ code: "review_exists", message: "This game already has an open review request." });
    harness.apiCall.mockRejectedValueOnce({ code: "internal_error", message: "Please try again." });
    render(<AskForReviewDialog {...PROPS} onClose={vi.fn()} />);
    fillQuestion();
    submitForm();
    const link = await screen.findByRole("link", { name: "See your requests" });
    expect(link.getAttribute("href")).toBe("/reviews/mine");
    expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe(QUESTION);
    submitForm();
    await screen.findByText("Please try again.");
    expect(screen.queryByRole("link", { name: "See your requests" })).toBeNull();
    submitForm();
    await waitFor(() => expect(harness.push).toHaveBeenCalledWith(`/reviews/${ID}`));
    expect(harness.apiCall).toHaveBeenCalledTimes(3);
  });

  it("resets all game-specific form state, including sharing consent, when selecting another replay", () => {
    const onClose = vi.fn();
    const { rerender } = render(<AskForReviewDialog {...PROPS} onClose={onClose} />);
    fillQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Macro" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Show my display name/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }));
    fireEvent.change(screen.getByLabelText("From (m:ss)"), { target: { value: "5:00" } });
    rerender(<AskForReviewDialog {...PROPS} gameId="g2" matchup="TvP" onClose={onClose} />);
    expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Macro" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText("From (m:ss)") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("checkbox", { name: /Show my display name/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("ignores a late successful response after the dialog is dismissed", async () => {
    let resolve!: (value: { id: string; url: string }) => void;
    harness.apiCall.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onClose = vi.fn();
    const { unmount } = render(<AskForReviewDialog {...PROPS} onClose={onClose} />);
    fillQuestion();
    submitForm();
    unmount();
    await act(async () => { resolve({ id: ID, url: `/reviews/${ID}` }); });
    expect(harness.push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("request time ranges", () => {
  it("uses phone-safe text input and explains then corrects numeric seconds", () => {
    render(<AskForReviewDialog {...PROPS} durationSec={852} onClose={vi.fn()} />);
    const start = screen.getByLabelText("From (m:ss)"); const end = screen.getByLabelText("To (m:ss)");
    expect(start.getAttribute("inputmode")).toBe("text"); expect(end.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(start, { target: { value: "500" } }); fireEvent.change(end, { target: { value: "9:00" } });
    expect(screen.getByText(/500 reads as 8:20 \(seconds\). Did you mean 5:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use 5:00" }));
    expect((start as HTMLInputElement).value).toBe("5:00");
    const echo = screen.getByText("Focus 5:00–9:00 of 14:12");
    expect(echo.getAttribute("aria-live")).toBe("polite");
    expect(start.getAttribute("aria-describedby")?.split(" ")).toContain(echo.id);
    expect(end.getAttribute("aria-describedby")?.split(" ")).toContain(echo.id);
  });

  it("sets matching quick ranges, clamps them to the game and clears with Whole game", () => {
    const { rerender } = render(<AskForReviewDialog {...PROPS} durationSec={450} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mid 5:00–7:30" }));
    expect(screen.getByRole("button", { name: "Mid 5:00–7:30" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("To (m:ss)") as HTMLInputElement).value).toBe("7:30");
    expect(screen.queryByRole("button", { name: /Late/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Whole game" }));
    expect((screen.getByLabelText("From (m:ss)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("To (m:ss)") as HTMLInputElement).value).toBe("");
    rerender(<AskForReviewDialog {...PROPS} gameId="short" durationSec={120} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Early 0:00–2:00" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mid/ })).toBeNull();
  });

  it("keeps dirty forms on scrim clicks and confirms Escape or Cancel, with Keep editing as the safe action", () => {
    const close = vi.fn(); render(<AskForReviewDialog {...PROPS} onClose={close} />);
    fillQuestion(); fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(close).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog", { name: "Discard this request?" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your question" }), { key: "Escape" });
    const confirm = screen.getByRole("dialog", { name: "Discard this request?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe(QUESTION);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Discard this request?" })).getByRole("button", { name: "Discard" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close a submitting request and explains level and link-only visibility with associated hints", async () => {
    let finish!: (value: { id: string; url: string }) => void;
    harness.apiCall.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const close = vi.fn(); render(<AskForReviewDialog {...PROPS} onClose={close} />);
    const level = screen.getByRole("combobox", { name: "Who should review" });
    const visibility = screen.getByRole("combobox", { name: "Visibility" });
    expect(document.getElementById(level.getAttribute("aria-describedby")!)?.textContent).toContain("verified from their own ranked games");
    expect(document.getElementById(visibility.getAttribute("aria-describedby")!)?.textContent).toContain("Anyone with the link can open it");
    fillQuestion(); submitForm(); fireEvent.keyDown(screen.getByRole("textbox", { name: "Your question" }), { key: "Escape" });
    expect(close).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog", { name: "Discard this request?" })).toBeNull();
    await act(async () => finish({ id: ID, url: `/reviews/${ID}` }));
  });

  it("accepts optional ranges and clock formats within the game's duration", () => {
    expect(parseRange("", " ", 640)).toEqual({ value: null, error: null });
    expect(parseRange("5:00", "390", 640)).toEqual({ value: { startSec: 300, endSec: 390 }, error: null });
    expect(parseRange("1:00:00", "1:10:00", null).value).toEqual({ startSec: 3600, endSec: 4200 });
  });

  it("rejects partial, invalid, reversed and out-of-contract ranges", () => {
    for (const [start, end] of [["5:00", ""], ["5:60", "6:30"], ["6:30", "5:00"], ["0", "86401"], ["0", "9".repeat(400)]]) {
      expect(parseRange(start, end, null).error).toBeTruthy();
    }
    expect(parseRange("5:00", "11:00", 640).error).toMatch(/inside the game/);
    expect(parseClock("9".repeat(400))).toBeNull();
    expect(parseClock(`${"9".repeat(400)}:00`)).toBeNull();
  });
});
