import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  clearFailedRequests,
  recentFailedRequests,
  recordFailedRequest,
} from "@/lib/feedback/failedRequests";
import { ReportIssueModal } from "../ReportIssueModal";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  me: {
    agentPaired: true,
    agentVersion: "0.19.0",
    agentLastSeenAt: new Date().toISOString(),
  } as Record<string, unknown> | undefined,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string | null) => ({ data: path === "/v1/me" ? harness.me : undefined }),
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "4f9c2ab1d0e3c6a7b8d9");
  window.history.replaceState(null, "", "/app/opponents/1-S2-1-99?tab=games");
  harness.apiCall.mockReset();
  harness.apiCall.mockResolvedValue({ ok: true, eventId: "e1" });
  recordFailedRequest({ path: "/v1/games?token=secret", status: 500, code: "internal_error", requestId: "req_1" });
});

afterEach(() => {
  cleanup();
  clearFailedRequests();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

function renderModal(props: Partial<Parameters<typeof ReportIssueModal>[0]> = {}) {
  const onClose = vi.fn();
  render(<ReportIssueModal open onClose={onClose} {...props} />);
  return { onClose };
}

function fill(subject: string, message: string) {
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: subject } });
  fireEvent.change(screen.getByRole("textbox", { name: /What happened|Tell us more|Your question/ }), {
    target: { value: message },
  });
}

function sentBody(): Record<string, unknown> {
  expect(harness.apiCall).toHaveBeenCalledTimes(1);
  const [, path, init] = harness.apiCall.mock.calls[0] as [unknown, string, RequestInit];
  expect(path).toBe("/v1/messages");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("ReportIssueModal", () => {
  it("sends the type, the words and every diagnostic it lists", async () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Report a problem" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "What is it?" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Problem" }) as HTMLInputElement).checked).toBe(true);

    fill("Opponents page is blank", "It spins forever after I open a dossier.");
    // Every item is ticked to start with.
    const panel = screen.getByText("Included with your report").closest("details") as HTMLElement;
    expect(within(panel).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(within(panel).getByText("6 of 6")).toBeTruthy();
    expect(within(panel).getByText("500 · /v1/games?token=%5Bredacted%5D · internal_error · ref req_1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByText("Thanks, we got it.");

    const body = sentBody();
    expect(body).toMatchObject({
      type: "problem",
      subject: "Opponents page is blank",
      message: "It spins forever after I open a dossier.",
    });
    expect(body.context).toMatchObject({
      page: "/app/opponents/1-S2-1-99",
      build: "4f9c2ab1d0e3",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      agentVersion: "0.19.0",
      agentStatus: "online",
      failedRequests: [{ path: "/v1/games?token=%5Bredacted%5D", status: 500, code: "internal_error", requestId: "req_1" }],
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    // Reported failures don't ride along on the next report.
    expect(recentFailedRequests()).toEqual([]);
  });

  it("leaves out each item the player unticks", async () => {
    renderModal();
    fill("Layout bug", "The table overflows.");
    fireEvent.click(screen.getByRole("checkbox", { name: /^Page/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Recent errors/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Desktop app/ }));
    expect(screen.getByText("3 of 6")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByText("Thanks, we got it.");
    const context = sentBody().context as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(["browser", "build", "viewport"]);
  });

  it("sends no context at all when everything is unticked", async () => {
    renderModal();
    fill("Hello", "Just a note.");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByText("0 of 6")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByText("Thanks, we got it.");
    expect(sentBody()).not.toHaveProperty("context");
  });

  it("switches between a problem, an idea and a question", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
    expect(screen.getByRole("dialog", { name: "Suggest a feature" })).toBeTruthy();
    fill("Map win rates", "Show my win rate on each map.");
    fireEvent.click(screen.getByRole("button", { name: "Send idea" }));
    await screen.findByText("Thanks, we got it.");
    expect(sentBody().type).toBe("idea");
  });

  it("starts on the type it was opened with", () => {
    renderModal({ prefill: { type: "question" } });
    expect(screen.getByRole("dialog", { name: "Ask a question" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Question" }) as HTMLInputElement).checked).toBe(true);
  });

  it("suggests help articles as the subject is typed", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "overlay not showing in obs" } });
    const section = await screen.findByRole("region", { name: "These might help" });
    expect(within(section).getByRole("link", { name: "Troubleshooting & support" }).getAttribute("href")).toBe(
      "/help/troubleshooting-and-support",
    );
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/help articles? might help/);

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "zz" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "These might help" })).toBeNull());
  });

  it("keeps the draft and shows the error when sending fails", async () => {
    harness.apiCall.mockRejectedValueOnce({ status: 429, message: "Please wait a few minutes and try again." });
    renderModal();
    fill("Broken", "Details here.");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Please wait a few minutes and try again.");
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Broken");
    expect(recentFailedRequests()).toHaveLength(1);
  });

  it("thanks the player, then Send another clears the subject and message", async () => {
    const { onClose } = renderModal();
    // The form puts the cursor in the subject once it has opened.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Subject")));
    fill("First", "First report.");
    fireEvent.click(screen.getByRole("radio", { name: "Question" }));
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    const thanks = await screen.findByText("Thanks, we got it.");
    await waitFor(() => expect(document.activeElement).toBe(thanks));

    fireEvent.click(screen.getByRole("button", { name: "Send another" }));
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("radio", { name: "Question" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Send question" }).hasAttribute("disabled")).toBe(true);

    fill("Second", "Second report.");
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Thanks, we got it.");
    const footer = screen.getByRole("button", { name: "Send another" }).closest("footer") as HTMLElement;
    fireEvent.click(within(footer).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts in the details when the subject comes prefilled", async () => {
    renderModal({ prefill: { subject: "Error on /app (ref 42)" } });
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Error on /app (ref 42)");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "What happened?" })));
  });

  it("prefills the details too, cut to the field limits", () => {
    renderModal({ prefill: { subject: "x".repeat(200), message: "Page: /app\nError ID: evt_1" } });
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toHaveLength(140);
    expect((screen.getByRole("textbox", { name: "What happened?" }) as HTMLTextAreaElement).value).toBe(
      "Page: /app\nError ID: evt_1",
    );
  });

  it("keeps what was typed when the parent re-renders with a new prefill object", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ReportIssueModal open onClose={onClose} prefill={{ type: "idea" }} />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "My draft" } });
    rerender(<ReportIssueModal open onClose={onClose} prefill={{ type: "idea" }} />);
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("My draft");
  });

  it("uses the Button primitive for its footer, with a loading send", async () => {
    let resolve!: () => void;
    harness.apiCall.mockReturnValueOnce(new Promise<void>((r) => { resolve = r; }));
    renderModal();
    expect(screen.getByRole("button", { name: "Send report" }).hasAttribute("disabled")).toBe(true);
    fill("Slow", "Still sending.");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    resolve();
    await screen.findByText("Thanks, we got it.");
  });
});
