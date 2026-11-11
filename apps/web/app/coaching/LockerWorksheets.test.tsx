import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadLockerBackup } from "./lockerBackup";
import type { LockerDocument } from "./lockerRosterModel";

const harness = vi.hoisted(() => ({
  data: undefined as LockerDocument | undefined, request: vi.fn(), mutate: vi.fn(), useApi: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "student-account" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => harness.useApi(...args) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
import LockerWorksheets from "./LockerWorksheets";

function fixture(): LockerDocument {
  return { rev: 7, scoped: true, state: {
    coaches: [{ id: "c1", name: "Coach" }],
    students: [{ id: "s1", coachId: "c1", name: "Student", focus: { name: "Protected" },
      worksheets: [{ id: "w1", state: "sent", title: "Replay review", answers: {}, blocks: [{ id: "q1", ty: "long", q: "Which cue?" }] }],
      submissions: [], shelf: [{ id: "shelf", t: "Training note" }] }],
    future: { unknown: [1, "two"] },
  } };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  sessionStorage.clear();
  harness.data = fixture();
  harness.useApi.mockReset().mockImplementation(() => ({ data: harness.data, request: harness.request, mutate: harness.mutate }));
  harness.request.mockReset().mockImplementation(async (init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    if (input.rev !== harness.data!.rev) throw { code: "conflict", status: 409 };
    harness.data = { ...harness.data!, state: input.state, rev: input.rev + 1 };
    return { ok: true, rev: harness.data.rev };
  });
  harness.mutate.mockReset().mockResolvedValue(undefined);
  Object.values(harness.toast).forEach(mock => mock.mockClear());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function enterAnswer() {
  fireEvent.click(screen.getByRole("button", { name: "Answer worksheet" }));
  fireEvent.change(screen.getByLabelText("Which cue?"), { target: { value: "Nexus" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Coach" }));
}

it("submits a student worksheet through the shared revision fence and restores its own backup", async () => {
  const original = fixture();
  const rendered = render(<LockerWorksheets viewerRole="student" memberId="s1" />);
  expect(harness.useApi).toHaveBeenCalledWith("/v1/coaching/state?worksheets=1", expect.any(Object));
  enterAnswer();
  await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Worksheet submitted"));
  expect(harness.data!.rev).toBe(8);
  const scope = ["student-account", "worksheets:student:s1"] as const;
  expect(await loadLockerBackup(scope, 8)).toMatchObject({ state: original.state, writtenRev: 8 });
  expect(await loadLockerBackup(["another-account", "worksheets:student:s1"], 8)).toBeNull();
  expect(await loadLockerBackup(["student-account", "shelf:student:s1"], 8)).toBeNull();
  rendered.rerender(<LockerWorksheets viewerRole="student" memberId="s1" />);
  const restore = screen.getByRole("button", { name: "Restore previous version" });
  await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(restore);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Restore previous version?" })).getByRole("button", { name: "Restore version" }));
  await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Previous worksheet version restored"));
  expect(harness.data!.state).toEqual(original.state);
});

it("keeps the answer when a backup cannot be saved and sends no request", async () => {
  vi.stubGlobal("indexedDB", undefined);
  render(<LockerWorksheets viewerRole="student" memberId="s1" />);
  enterAnswer();
  await waitFor(() => expect(harness.toast.error).toHaveBeenCalledWith("Backup could not be saved", expect.any(Object)));
  expect(harness.request).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Which cue?") as HTMLTextAreaElement).value).toBe("Nexus");
  expect(harness.data).toEqual(fixture());
});
