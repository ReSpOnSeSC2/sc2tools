import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssignmentModal } from "./AssignmentModal";
import type { AssignmentDraft } from "./coachingPracticeModel";

const students = [{ id: "alex", name: "Alex" }, { id: "blair", name: "Blair" }];
function draft(patch: Partial<AssignmentDraft> = {}): AssignmentDraft {
  return { studentId: "alex", type: "build", requiredGames: "5", buildSelection: "manual", buildName: "",
    recurrence: "weekly", totalRangeInitialized: false, dateRangeEdited: false, startsOn: "2026-10-20", endsOn: "2026-10-26",
    timeZone: "UTC", title: "", note: "", clientRequestId: "request", ...patch };
}
function Editor({ initial = draft(), onSave = vi.fn(), saving = false }: {
  initial?: AssignmentDraft; onSave?: () => void; saving?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return <AssignmentModal draft={value} students={students} buildSuggestions={[]} browserTimeZone="UTC"
    saving={saving} onChange={setValue} onClose={vi.fn()} onSave={onSave} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); document.body.style.overflow = ""; });

describe("assignment form feedback", () => {
  it("disables submission and shows touched errors connected to the actual field", () => {
    const save = vi.fn(); render(<Editor onSave={save} />);
    const assign = screen.getByRole("button", { name: "Assign plan" });
    const build = screen.getByRole("textbox", { name: "Exact detected style name" });
    expect(assign.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(build);
    expect(build.getAttribute("aria-invalid")).toBe("true");
    const errorId = build.getAttribute("aria-describedby")!;
    expect(document.getElementById(errorId)?.textContent).toBe("Enter the exact detected style name.");
    fireEvent.click(assign); expect(save).not.toHaveBeenCalled();
    fireEvent.change(build, { target: { value: "Phoenix opener" } });
    expect(build.getAttribute("aria-invalid")).toBeNull();
    expect(assign.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Alex plays 5 eligible 1v1 games using Phoenix opener");
    fireEvent.click(assign); expect(save).toHaveBeenCalledTimes(1);
  });

  it("focuses the first invalid control from the visible fix action, Enter, or a form submit", async () => {
    const save = vi.fn(); render(<Editor initial={draft({ requiredGames: "0" })} onSave={save} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const build = screen.getByRole("textbox", { name: "Exact detected style name" });
    const games = screen.getByRole("spinbutton", { name: "Required games" });
    fireEvent.click(screen.getByRole("button", { name: "Fix 2 fields to assign" }));
    expect(document.activeElement).toBe(build);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    games.focus(); fireEvent.keyDown(games, { key: "Enter" });
    expect(document.activeElement).toBe(build); expect(save).not.toHaveBeenCalled();
    fireEvent.change(build, { target: { value: "Phoenix opener" } });
    fireEvent.submit(build.closest("form")!);
    expect(document.activeElement).toBe(games);
    fireEvent.change(games, { target: { value: "8" } });
    fireEvent.submit(build.closest("form")!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("switches students to their remembered zone and keeps directly edited dates", () => {
    localStorage.setItem("sc2tools:coaching:tz:blair", "Asia/Tokyo");
    render(<Editor initial={draft({ dateRangeEdited: true })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Student" }), { target: { value: "blair" } });
    const zones = screen.getByRole("combobox", { name: "Player's time zone" }) as HTMLSelectElement;
    expect(zones.value).toBe("Asia/Tokyo");
    expect(Array.from(zones.options).filter((option) => option.value).slice(0, 2).map((option) => option.value)).toEqual(["Asia/Tokyo", "UTC"]);
    expect((screen.getByLabelText(/^Starts/) as HTMLInputElement).value).toBe("2026-10-20");
    expect((screen.getByLabelText(/^Ends/) as HTMLInputElement).value).toBe("2026-10-26");
  });

  it("updates a total-target summary with its cadence and hides it when dates become invalid", () => {
    render(<Editor initial={draft({ type: "total" })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat target" }), { target: { value: "monthly" } });
    expect(screen.getByRole("status").textContent).toContain("each month");
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: "2026-10-19" } });
    fireEvent.blur(screen.getByLabelText(/^Ends/));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("alert").textContent).toBe("Ends before it starts.");
  });
});
