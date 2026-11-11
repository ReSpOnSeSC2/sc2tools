import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LockerDocument } from "./lockerRosterModel";

const api = vi.hoisted(() => ({
  data: undefined as LockerDocument | undefined, request: vi.fn(), mutate: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "fixture" }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: api.data, request: api.request, mutate: api.mutate }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: api.toast }) }));

import LockerShelf from "./LockerShelf";
import { loadLockerBackup } from "./lockerBackup";
import { mediaSource, shelfLink } from "./lockerShelfModel";

function locker(): LockerDocument {
  return { rev: 3, scoped: true, state: {
    students: [
      { id: "s1", name: "Alex", coachId: "c1", worksheets: [{ id: "w", blocks: [{ ty: "image", img: "legacy" }] }],
        shelf: [{ id: "one", ty: "notes", t: "Practice plan", n: "Keep the worker lead", d: "2026-10-19T12:00:00.000Z", future: { x: 1 } },
          { id: "two", ty: "replay", t: "Private game", link: "/app/game/abc", game: { m: "Goldenaura", o: "Example" } }] },
      { id: "s2", name: "Jordan", coachId: "c1", focus: { goal: "New build" }, shelf: [{ id: "older", ty: "pdf", t: "PDF drill", asset: "file" }] },
    ],
    assets: { file: { n: "Drill.pdf", mime: "application/pdf", b64: "YQ==", size: 1 } },
    customBuilds: [{ id: "b1", future: [1, null, "legacy"] }], wsTemplates: [{ id: "tpl" }], shelfLibrary: [],
  } };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  api.data = locker();
  api.request.mockReset().mockImplementation(async (request: RequestInit) => {
    const body = JSON.parse(String(request.body)); const current = api.data!;
    expect(body.rev).toBe(current.rev);
    api.data = { ...current, state: body.state, rev: current.rev + 1 };
    return { ok: true, rev: api.data.rev };
  });
  api.mutate.mockReset().mockResolvedValue(undefined);
  Object.values(api.toast).forEach(mock => mock.mockClear());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const coach = <LockerShelf viewerRole="coach" memberId="c1" />;

it("round-trips a Locker export through the actual note editor and restores it from the confirmed backup", async () => {
  const original = locker();
  const view = render(coach);
  fireEvent.click(screen.getByRole("button", { name: "Add shelf item" }));
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "New drill" } });
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Practice six minutes" } });
  fireEvent.click(screen.getByRole("button", { name: "Add item" }));
  await waitFor(() => expect(api.toast.success).toHaveBeenCalledWith("Item added"));
  const [added, ...originalCards] = api.data!.state.students![0].shelf as object[];
  expect(added).toMatchObject({ ty: "notes", t: "New drill", n: "Practice six minutes", d: expect.any(String) });
  const next = structuredClone(api.data!.state);
  next.students![0].shelf = originalCards;
  expect(next).toEqual(original.state);
  expect((await loadLockerBackup(["fixture", "shelf:coach:c1"], 4))?.state).toEqual(original.state);
  view.rerender(<LockerShelf viewerRole="coach" memberId="c1" />);
  const restore = screen.getByRole("button", { name: "Restore previous version" });
  await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(restore);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore version" }));
  await waitFor(() => expect(api.data?.rev).toBe(5));
  expect(api.data!.state).toEqual(original.state);
});

it("uses the shared library with fresh card identity, while keeping an individual replay private", async () => {
  render(coach);
  expect(screen.queryByRole("button", { name: "Save to library: Private game" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save to library: Practice plan" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save to library" }));
  await waitFor(() => expect(api.toast.success).toHaveBeenCalledWith("Saved to library"));
  const [copy] = api.data!.state.shelfLibrary as Array<{ id: string }>;
  expect(copy).toMatchObject({ t: "Practice plan", future: { x: 1 } });
  expect(copy.id).not.toBe("one"); expect(copy).not.toHaveProperty("d");
  fireEvent.click(screen.getByRole("tab", { name: "Shared library" }));
  fireEvent.change(screen.getByLabelText("Copy to student"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "Copy to shelf: Practice plan" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(api.toast.success).toHaveBeenCalledWith("Copied to student shelf"));
  const [studentCopy, original] = api.data!.state.students![1].shelf as Array<{ id: string }>;
  expect(studentCopy).toMatchObject({ t: "Practice plan", d: expect.any(String), future: { x: 1 } });
  expect(studentCopy.id).not.toBe(copy.id);
  expect(original.id).toBe("older");
});

it("shows only a student's assigned shelf with no edit or library controls", () => {
  render(<LockerShelf viewerRole="student" memberId="s2" />);
  expect(screen.getByRole("heading", { name: "Your shelf" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "PDF drill" })).toBeTruthy();
  expect(screen.queryByText("Private game")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Shared library" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add shelf item" })).toBeNull();
  expect(api.request).not.toHaveBeenCalled();
});

it("blocks unsafe links and active media while retaining safe Legacy attachment formats", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,example", "//example.test/x", "https://a:b@example.test/x"]) expect(shelfLink(value)).toBeNull();
  expect(shelfLink("/app/game/example")).toBe("/app/game/example");
  expect(mediaSource("image", { n: "bad.svg", mime: "image/svg+xml", b64: "YWJj", size: 3 })).toBeUndefined();
  expect(mediaSource("voice", { n: "memo.webm", mime: "audio/webm;codecs=opus", b64: "YWJj", size: 3 })).toBe("data:audio/webm;codecs=opus;base64,YWJj");
});
