import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LockerDocument } from "./lockerRosterModel";

const api = vi.hoisted(() => ({ data: undefined as LockerDocument | undefined, error: undefined as { status: number } | undefined,
  request: vi.fn(), mutate: vi.fn(), get: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "fixture" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => {
  api.get(path);
  return { data: api.data, error: api.error, request: api.request, mutate: api.mutate };
} }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: api.toast }) }));

import LockerContentStudio from "./LockerContentStudio";
import { loadLockerBackup } from "./lockerBackup";

const PDF = new File(["%PDF-1.7\nfixture"], "Practice card.pdf", { type: "application/pdf" });
function classicFixture(): LockerDocument {
  return { rev: 7, scoped: true, state: {
    students: [
      { id: "s1", name: "Alex", coachId: "c1", shelf: [{ id: "existing", ty: "notes", t: "Existing note", future: { format: "keep" } }],
        worksheets: [{ id: "worksheet", blocks: [{ ty: "image", img: "legacy" }] }] },
      { id: "s2", name: "Jordan", coachId: "c1", shelf: [{ id: "private", ty: "notes", t: "Second student" }], future: [1, 2, 3] },
    ],
    assets: { old: { n: "old.png", mime: "image/png", b64: "YQ==", size: 1 } },
    wsTemplates: [{ id: "legacy-template" }], shelfLibrary: [{ id: "guide", ty: "notes" }], future: { keep: true },
  } };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  api.data = classicFixture(); api.error = undefined; api.get.mockClear();
  api.request.mockReset().mockImplementation(async (request: RequestInit) => {
    const body = JSON.parse(String(request.body)), current = api.data!;
    expect(body.rev).toBe(current.rev);
    api.data = { ...current, state: body.state, rev: current.rev + 1 };
    return { ok: true, rev: api.data.rev };
  });
  api.mutate.mockReset().mockResolvedValue(undefined);
  Object.values(api.toast).forEach(mock => mock.mockClear());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const studio = <LockerContentStudio viewerRole="coach" memberId="c1" />;

it("opens help inside the coaching workspace", () => {
  render(studio);
  fireEvent.click(screen.getByRole("button", { name: "Content Studio help" }));
  const help = screen.getByRole("dialog", { name: "Content Studio help" });
  expect(within(help).getByText(/authorized share link or replay file/)).toBeTruthy();
  fireEvent.click(within(help).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("round-trips Classic notes and restores from Content Studio's independent backup scope", async () => {
  const original = classicFixture();
  const view = render(studio);
  expect(api.get).toHaveBeenCalledWith("/v1/coaching/state?shelf=1");
  fireEvent.click(screen.getByRole("button", { name: "Session notes" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Teach one cue" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Session notes" }), { target: { value: "See it before spending." } });
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(api.data?.rev).toBe(8));
  const [added, ...older] = api.data!.state.students![0].shelf as object[];
  expect(added).toMatchObject({ ty: "notes", t: "Teach one cue", n: "See it before spending." });
  const next = structuredClone(api.data!.state); next.students![0].shelf = older;
  expect(next).toEqual(original.state);
  expect((await loadLockerBackup(["fixture", "content-studio:coach:c1"], 8))?.state).toEqual(original.state);
  expect(await loadLockerBackup(["fixture", "shelf:coach:c1"], 8)).toBeNull();
  view.rerender(<LockerContentStudio viewerRole="coach" memberId="c1" />);
  const restore = screen.getByRole("button", { name: "Restore previous version" });
  await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(restore);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore version" }));
  await waitFor(() => expect(api.data?.rev).toBe(9));
  expect(api.data!.state).toEqual(original.state);
});

it("stores a validated PDF in the exact Shelf asset format on only the selected student's shelf", async () => {
  const original = classicFixture();
  render(studio);
  fireEvent.change(screen.getByRole("combobox", { name: "Student shelf" }), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "PDF practice card" }));
  fireEvent.change(screen.getByLabelText("Attach a file"), { target: { files: [PDF] } });
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(api.data?.rev).toBe(8));
  const [added, ...older] = api.data!.state.students![1].shelf as { asset: string }[];
  expect(added).toMatchObject({ ty: "pdf", t: "PDF practice card", asset: expect.any(String) });
  const next = structuredClone(api.data!.state);
  const assets = next.assets as Record<string, unknown>;
  expect(assets[added.asset]).toMatchObject({ n: "Practice card.pdf", mime: "application/pdf", b64: expect.any(String), size: PDF.size });
  delete assets[added.asset]; next.students![1].shelf = older;
  expect(next).toEqual(original.state);
});

it("keeps a stale draft and adds it over the latest revision only after the coach retries", async () => {
  const view = render(studio);
  fireEvent.click(screen.getByRole("button", { name: "Session notes" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Session notes" }), { target: { value: "Keep this draft." } });
  const changed = structuredClone(api.data!);
  changed.rev++;
  const external = { id: "external", ty: "notes", t: "Concurrent coaching note" };
  (changed.state.students![0].shelf as object[]).unshift(external);
  api.data = changed;
  view.rerender(<LockerContentStudio viewerRole="coach" memberId="c1" />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add to shelf" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Session notes" }).value).toBe("Keep this draft.");
  expect(api.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use the latest shelf revision" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(api.data?.rev).toBe(9));
  expect(api.data!.state.students![0].shelf).toMatchObject([
    { ty: "notes", n: "Keep this draft." }, external, { id: "existing" },
  ]);
});

it("retains a draft through a retryable shelf read error, blocks writes, and clears it on authorization refusal", async () => {
  const view = render(studio);
  fireEvent.click(screen.getByRole("button", { name: "Session notes" }));
  const note = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Session notes" });
  fireEvent.change(note, { target: { value: "Keep this draft." } });
  api.error = { status: 503 };
  view.rerender(<LockerContentStudio viewerRole="coach" memberId="c1" />);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Session notes" }).value).toBe("Keep this draft.");
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Add to shelf" });
  expect(submit.disabled).toBe(true);
  fireEvent.submit(submit.form!);
  expect(api.request).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry Locker" }));
  expect(api.mutate).toHaveBeenCalledOnce();
  api.error = undefined;
  view.rerender(<LockerContentStudio viewerRole="coach" memberId="c1" />);
  expect(submit.disabled).toBe(false);
  expect(note.value).toBe("Keep this draft.");
  api.error = { status: 403 };
  view.rerender(<LockerContentStudio viewerRole="coach" memberId="c1" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Existing note")).toBeNull();
  expect(screen.getByRole("heading", { name: "Content Studio could not load" })).toBeTruthy();
});
