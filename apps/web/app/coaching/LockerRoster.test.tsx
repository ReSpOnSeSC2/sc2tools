import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLockerBackup, stageLockerBackup, confirmLockerBackup } from "./lockerBackup";
import type { LockerDocument } from "./lockerRosterModel";

const test = vi.hoisted(() => ({
  data: undefined as LockerDocument | undefined,
  request: vi.fn(),
  mutate: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "fixture-account" }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: test.data, request: test.request, mutate: test.mutate }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: test.toast }) }));
import LockerRoster from "./LockerRoster";

function fixture(): LockerDocument {
  return {
    rev: 11, scoped: false,
    state: {
      v: 1, setup: true, futureField: { values: [1, "x", null] },
      coaches: [{ id: "c1", name: "Coach One" }, { id: "c2", name: "Coach Two" }],
      students: [
        { id: "s1", name: "Alex", note: "Macro", coachId: "c1", userId: "u1",
          shelf: [{ id: "i1", t: "Replay", asset: "f1" }], worksheets: [{ id: "w1", rows: [{ answer: "Review" }] }] },
        { id: "s2", name: "Jordan", note: "Timing", coachId: "c2", userId: "u2", focus: { next: "Review" } },
      ],
      assets: { f1: { mime: "text/plain", data: "data:text/plain,fixture" } },
      shelfLibrary: [{ id: "lib", title: "Replay library" }], wsTemplates: [{ id: "t1", name: "Routine" }],
      customBuilds: [{ id: "b1", log: [[0, "Build"]] }],
    } as LockerDocument["state"],
  };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  test.data = fixture();
  test.request.mockReset().mockImplementation(async (request: RequestInit) => {
    const body = JSON.parse(String(request.body));
    const current = test.data!;
    if (body.rev !== current.rev) throw { code: "conflict", status: 409 };
    test.data = { ...current, state: body.state, rev: current.rev + 1 };
    return { ok: true, rev: test.data.rev };
  });
  test.mutate.mockReset().mockResolvedValue(undefined);
  Object.values(test.toast).forEach((mock) => mock.mockClear());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Locker roster backup and restore", () => {
  it("round-trips an exported Locker shape through a roster edit and restores the exact snapshot", async () => {
    const original = fixture();
    const view = render(<LockerRoster viewerRole="admin" coachId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Alex" }));
    const editor = screen.getByRole("dialog", { name: "Edit Alex" });
    fireEvent.change(within(editor).getByLabelText("Focus note"), { target: { value: "Block timing" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(test.toast.success).toHaveBeenCalledWith("Student updated"));
    const saved = test.data!;
    expect(saved.rev).toBe(original.rev + 1);
    const expected = fixture();
    expected.state.students![0].note = "Block timing";
    expect(saved.state).toEqual(expected.state);
    view.rerender(<LockerRoster viewerRole="admin" coachId="c1" />);
    const restore = screen.getByRole("button", { name: "Restore previous version" });
    await waitFor(() => expect(restore.hasAttribute("disabled")).toBe(false));
    fireEvent.click(restore);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Restore previous version?" })).getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(test.toast.success).toHaveBeenCalledWith("Previous Locker version restored"));
    expect(test.data!.state).toEqual(original.state);
  });

  it("leaves the Locker unchanged if it cannot back up the current revision", async () => {
    vi.stubGlobal("indexedDB", undefined);
    render(<LockerRoster viewerRole="admin" coachId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Alex" }));
    fireEvent.change(screen.getByLabelText("Focus note"), { target: { value: "Different" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(test.toast.error).toHaveBeenCalledWith("Backup could not be saved", { description: expect.any(String) }));
    expect(test.request).not.toHaveBeenCalled();
    expect(test.data).toEqual(fixture());
  });

  it("restores only confirmed snapshots under their own account, view and exact revision", async () => {
    const document = fixture();
    const scope = ["coach-a", "roster"] as const;
    await stageLockerBackup(scope, document);
    expect(await loadLockerBackup(scope, 12)).toBeNull();
    await confirmLockerBackup(scope, 11, 12);
    expect(await loadLockerBackup(scope, 12)).toMatchObject({ state: document.state, writtenRev: 12 });
    expect(await loadLockerBackup(scope, 13)).toBeNull();
    expect(await loadLockerBackup(["coach-b", "roster"], 12)).toBeNull();
    expect(await loadLockerBackup(["coach-a", "shelf"], 12)).toBeNull();
  });
});
