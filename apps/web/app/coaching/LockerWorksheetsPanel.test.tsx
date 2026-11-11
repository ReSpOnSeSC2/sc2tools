import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockerWorksheetsPanel, type WorksheetLockerView } from "./LockerWorksheetsPanel";
import { worksheetAnswerDraftKey } from "./LockerWorksheetAnswers";
import type { LockerDocument } from "./lockerRosterModel";

function fixture(): LockerDocument {
  return {
    rev: 7, scoped: true,
    state: {
      v: 1, setup: true, futureField: { values: [1, "x", null] },
      coaches: [{ id: "c1", name: "Coach One" }],
      students: [{ id: "s1", name: "Student A", coachId: "c1", shelf: [{ id: "asset-card", asset: "f1" }],
        worksheets: [
          { id: "draft", title: "First draft", state: "draft", answers: {}, blocks: [{ id: "prompt", ty: "long", q: "First question", future: true }] },
          { id: "sent", title: "Read the game", state: "sent", answers: {}, blocks: [
            { id: "q1", ty: "long", q: "What was your first cue?" }, { id: "q2", ty: "replay", q: "Attach your game" },
          ] },
          { id: "unknown", storedByFutureEditor: { note: "Keep" } },
        ], submissions: [], focus: { title: "Scout" } },
      { id: "s2", name: "Other student", coachId: "c2", worksheets: [{ id: "w2", title: "Private other draft", state: "draft", blocks: [], answers: {} }] }],
      assets: { f1: { mime: "text/plain", data: "data:text/plain,fixture" } },
      shelfLibrary: [{ id: "lib", title: "Replay library" }], wsTemplates: [], customBuilds: [{ id: "b1", log: [[0, "Build"]] }],
    },
  };
}

function renderWorksheets(role: "coach" | "student" = "coach", initial = fixture()) {
  const writes = vi.fn<WorksheetLockerView["save"]>();
  function Harness() {
    const [doc, setDoc] = useState(initial);
    const [backup, setBackup] = useState<WorksheetLockerView["backup"]>(null);
    const save: WorksheetLockerView["save"] = async (state, revision, message) => {
      await writes(state, revision, message);
      if (revision !== doc.rev) return false;
      setBackup({ state: doc.state, savedAt: 1, writtenRev: doc.rev + 1 });
      setDoc({ ...doc, state, rev: doc.rev + 1 });
      return true;
    };
    return <LockerWorksheetsPanel accountId="test-account" role={role} memberId={role === "coach" ? "c1" : "s1"}
      locker={{ document: doc, loading: false, retry: async () => undefined, busy: false, backup, save }} />;
  }
  return { writes, ...render(<Harness />) };
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("React Locker Worksheets", () => {
  it("round-trips a draft edit and restores the original Locker shape", async () => {
    const original = fixture();
    const { writes } = renderWorksheets("coach", original);
    expect(screen.queryByText("Other student")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit First draft" }));
    const editor = within(screen.getByRole("dialog", { name: "Worksheet for Student A" }));
    fireEvent.change(editor.getByLabelText("Question 1"), { target: { value: "First cue to find" } });
    fireEvent.click(editor.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const expected = structuredClone(original);
    const rows = expected.state.students![0].worksheets as { blocks?: { q: string }[] }[];
    rows[0].blocks![0].q = "First cue to find";
    expect(writes).toHaveBeenCalledWith(expected.state, 7, "Worksheet draft saved");
    fireEvent.click(screen.getByRole("button", { name: "Restore previous version" }));
    const restore = within(screen.getByRole("dialog", { name: "Restore previous version?" }));
    fireEvent.click(restore.getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith(original.state, 8, "Previous worksheet version restored"));
  });

  it("keeps the coach's playbook outside both a draft and a sent worksheet", async () => {
    const { writes } = renderWorksheets();
    fireEvent.click(screen.getByRole("button", { name: "Guided planning" }));
    const plan = within(screen.getByRole("dialog", { name: "Plan a worksheet" }));
    fireEvent.change(plan.getByLabelText("Evidence"), { target: { value: "Synthetic private playbook thought" } });
    fireEvent.click(plan.getByRole("button", { name: "Keep plan beside a draft" }));
    expect(screen.getByText("Synthetic private playbook thought")).toBeTruthy();
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to Student A" }));
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    const [state] = writes.mock.calls[0];
    expect(JSON.stringify(state)).not.toContain("Synthetic private playbook thought");
    expect(state.students![0].worksheets).toEqual(expect.arrayContaining([expect.objectContaining({ state: "sent", title: "Coaching decision check-in" })]));
  });

  it("filters system templates by matchup and only writes when copied unchanged", async () => {
    const { writes } = renderWorksheets();
    fireEvent.click(screen.getByRole("button", { name: "Template library" }));
    const library = within(screen.getByRole("dialog", { name: "Worksheet template library" }));
    expect(library.getByRole("list", { name: "System worksheet templates" }).children).toHaveLength(13);
    fireEvent.change(library.getByLabelText("Template matchup"), { target: { value: "TvT" } });
    const matches = library.getByRole("list", { name: "System worksheet templates" });
    expect(matches.children).toHaveLength(1);
    fireEvent.click(within(matches).getByRole("button", { name: "Use as-is" }));
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(writes.mock.calls[0][0].students![0].worksheets).toEqual(expect.arrayContaining([expect.objectContaining({ state: "draft", title: expect.stringContaining("TvT decision lab") })]));
  });

  it("restores an account-local answer, attaches a replay, and writes only the selected student response", async () => {
    const key = worksheetAnswerDraftKey("test-account", "sent");
    const other = worksheetAnswerDraftKey("other-account", "sent");
    sessionStorage.setItem(key, JSON.stringify({ q1: "My first cue", q2: { count: 8 }, unexpected: "Ignore" }));
    sessionStorage.setItem(other, JSON.stringify({ q1: "Other person's draft" }));
    const { writes } = renderWorksheets("student");
    expect(screen.queryByText("First draft")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer worksheet" }));
    expect((screen.getByLabelText("What was your first cue?") as HTMLTextAreaElement).value).toBe("My first cue");
    const replay = new File([new Uint8Array([65, 66, 67])], "Fixture.SC2Replay");
    fireEvent.change(screen.getByLabelText("Attach replays for question 2"), { target: { files: [replay] } });
    expect(await screen.findByText("Fixture.SC2Replay")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to Coach One" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem(other)).toContain("Other person's draft");
    const [state, revision] = writes.mock.calls[0];
    expect(revision).toBe(7);
    expect(state.students![0].worksheets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "sent", state: "submitted", answers: { q1: "My first cue", q2: { count: 1 } } })]));
    expect(state.students![0].submissions).toEqual([expect.objectContaining({ b64: "QUJD", build: "worksheet: Read the game", size: 3 })]);
    expect(state.students![1]).toEqual(fixture().state.students![1]);
    expect(state.assets).toEqual(fixture().state.assets);
  });
});
