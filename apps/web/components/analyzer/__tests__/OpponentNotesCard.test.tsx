import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
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

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

afterEach(cleanup);

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
        "Saved to scouting",
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
      (screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
