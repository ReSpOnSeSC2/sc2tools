import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  userId: "owner-1",
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, userId: harness.userId, isLoaded: true }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
}));

vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: harness.toast }),
}));

import {
  OPPONENT_NOTES_MAX_LENGTH,
  OpponentNotesCard,
} from "../OpponentNotesCard";
import { UnsavedNoteProvider } from "../UnsavedNoteContext";

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.userId = "owner-1";
  harness.getToken.mockClear();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

describe("opponent note draft safety", () => {
  const textbox = () => screen.getByRole("textbox", { name: "Scouting notes for this opponent" }) as HTMLTextAreaElement;
  it("debounces storage, flushes on unmount, restores, and discards without resurrecting the draft", () => {
    vi.useFakeTimers();
    const view = render(<OpponentNotesCard pulseId="draft" initialNotes="Saved" />);
    fireEvent.change(textbox(), { target: { value: "Private draft" } });
    act(() => vi.advanceTimersByTime(499));
    expect(sessionStorage.getItem("opponent-note-draft:draft")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(sessionStorage.getItem("opponent-note-draft:draft")!).draft.notes).toBe("Private draft");
    fireEvent.change(textbox(), { target: { value: "Newest draft" } });
    view.unmount();
    expect(JSON.parse(sessionStorage.getItem("opponent-note-draft:draft")!).draft.notes).toBe("Newest draft");
    const restored = render(<OpponentNotesCard pulseId="draft" initialNotes="Saved" />);
    expect(textbox().value).toBe("Newest draft");
    expect(screen.getByText(/Unsaved draft restored/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard restored draft" }));
    expect(textbox().value).toBe("Saved");
    restored.unmount();
    expect(sessionStorage.getItem("opponent-note-draft:draft")).toBeNull();
  });
  it("keeps a live draft through server refreshes and never restores another account's private draft", () => {
    const view = render(<OpponentNotesCard pulseId="shared-device" initialNotes="Saved" />);
    fireEvent.change(textbox(), { target: { value: "Owner one's draft" } });
    view.rerender(<OpponentNotesCard pulseId="shared-device" initialNotes="Saved in another tab" />);
    expect(textbox().value).toBe("Owner one's draft");
    harness.userId = "owner-2";
    view.rerender(<OpponentNotesCard pulseId="shared-device" initialNotes="Owner two's saved note" />);
    expect(textbox().value).toBe("Owner two's saved note");
    expect(screen.queryByText(/Unsaved draft restored/)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("opponent-note-draft:shared-device")!).ownerId).toBe("owner-1");
  });
  it.each(["ctrlKey", "metaKey"])("saves with %s+Enter and clears the saved draft", async (modifier) => {
    harness.apiCall.mockResolvedValue({ notes: "Save by keyboard", notesReadAloud: false });
    render(<OpponentNotesCard pulseId="keyboard" />);
    fireEvent.change(textbox(), { target: { value: "Save by keyboard" } });
    fireEvent.keyDown(textbox(), { key: "Enter", [modifier]: true });
    await waitFor(() => expect(screen.getByText("Saved just now")).toBeTruthy());
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("opponent-note-draft:keyboard")).toBeNull();
  });
  it("only shows the counter below 100 remaining and warns before unload only while dirty", () => {
    render(<OpponentNotesCard pulseId="counter" />);
    expect(screen.queryByText(/characters left/)).toBeNull();
    const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(textbox(), { target: { value: "a".repeat(99) } });
    expect(screen.queryByText(/characters left/)).toBeNull();
    fireEvent.change(textbox(), { target: { value: "a".repeat(401) } });
    expect(screen.getByText("99 characters left")).toBeTruthy();
    const dirty = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(sessionStorage.getItem("opponent-note-draft:counter")).not.toBeNull();
    fireEvent.change(textbox(), { target: { value: "a".repeat(500) } });
    expect(screen.getByText("0 characters left").className).toContain("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const discarded = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(discarded);
    expect(discarded.defaultPrevented).toBe(false);
  });
  it("preserves edits typed while an earlier save is pending", async () => {
    let resolve!: (value: { notes: string; notesReadAloud: boolean }) => void;
    harness.apiCall.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<OpponentNotesCard pulseId="pending" />);
    fireEvent.change(textbox(), { target: { value: "Submitted" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    fireEvent.change(textbox(), { target: { value: "Newer edit" } });
    await act(async () => { resolve({ notes: "Submitted", notesReadAloud: false }); });
    expect(textbox().value).toBe("Newer edit");
    expect(screen.getByText("Saved. You have newer unsaved changes.")).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem("opponent-note-draft:pending")!).draft.notes).toBe("Newer edit");
    expect((screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps failed notes recoverable and retries the same submitted text", async () => {
    harness.apiCall.mockRejectedValueOnce({ message: "Offline" }).mockResolvedValueOnce({ notes: "Retry me", notesReadAloud: false });
    render(<OpponentNotesCard pulseId="retry" />);
    fireEvent.change(textbox(), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByRole("alert");
    expect(textbox().value).toBe("Retry me");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Saved just now");
    expect(JSON.parse(harness.apiCall.mock.calls[1][2].body).notes).toBe("Retry me");
  });
  it("guards an ancestor chrome breadcrumb with safe Keep editing focus and discards before leaving", async () => {
    const leave = vi.fn();
    render(<><Link href="/app/opponents?q=alpha">Chrome Opponents</Link><UnsavedNoteProvider onLeaveList={leave}><OpponentNotesCard pulseId="guard" /></UnsavedNoteProvider></>);
    fireEvent.change(textbox(), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("link", { name: "Chrome Opponents" }));
    let dialog = screen.getByRole("dialog", { name: "Discard unsaved note?" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep editing" })));
    expect(leave).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(textbox().value).toBe("Unsaved");
    fireEvent.click(screen.getByRole("link", { name: "Chrome Opponents" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("opponent-note-draft:guard")).toBeNull();
  });
});

afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });

describe("OpponentNotesCard", () => {
  it("saves private notes and the per-opponent read-aloud choice", async () => {
    const onSaved = vi.fn();
    harness.apiCall.mockResolvedValue({
      notes: "Watch the proxy path at 2:30.",
      notesReadAloud: true,
    });

    render(
      <OpponentNotesCard
        pulseId="1-S2-1/a"
        initialNotes="Checks for greed first."
        initialNotesReadAloud={false}
        onSaved={onSaved}
      />,
    );

    const notes = screen.getByRole("textbox", {
      name: "Scouting notes for this opponent",
    }) as HTMLTextAreaElement;
    expect(notes.value).toBe("Checks for greed first.");
    expect(notes.maxLength).toBe(OPPONENT_NOTES_MAX_LENGTH);

    fireEvent.change(notes, {
      target: { value: "Watch the proxy path at 2:30." },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Read opponent notes aloud" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    expect(harness.apiCall).toHaveBeenCalledWith(
      harness.getToken,
      "/v1/opponents/1-S2-1%2Fa/notes",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          notes: "Watch the proxy path at 2:30.",
          notesReadAloud: true,
        }),
      }),
    );
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({
        notes: "Watch the proxy path at 2:30.",
        notesReadAloud: true,
      });
      expect(screen.getByRole("status").textContent).toContain(
        "Saved just now",
      );
    });
  });

  it("turns read-aloud off when the visual note is cleared", async () => {
    harness.apiCall.mockResolvedValue({ notes: "", notesReadAloud: false });
    render(
      <OpponentNotesCard
        pulseId="opp-2"
        initialNotes="Always scouts clockwise."
        initialNotesReadAloud
      />,
    );

    const notes = screen.getByRole("textbox", {
      name: "Scouting notes for this opponent",
    });
    fireEvent.change(notes, { target: { value: "" } });
    const readAloud = screen.getByRole("switch", {
      name: "Read opponent notes aloud",
    }) as HTMLButtonElement;
    expect(readAloud.getAttribute("aria-checked")).toBe("false");
    expect(readAloud.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    const request = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      notes: "",
      notesReadAloud: false,
    });
  });

  it("keeps edits retryable and exposes an accessible save error", async () => {
    harness.apiCall.mockRejectedValue({
      status: 500,
      message: "Notes service is unavailable.",
    });
    render(<OpponentNotesCard pulseId="opp-3" />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Scouting notes for this opponent",
      }),
      { target: { value: "Scout the third early." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Notes service is unavailable.");
    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
