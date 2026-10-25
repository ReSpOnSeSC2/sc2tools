import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildStudioEditor } from "./BuildStudioEditor";
import type { BuildDetail } from "./studioTypes";
const mocks = vi.hoisted(() => ({ call: vi.fn(), token: vi.fn(async () => "admin") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: mocks.token }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => mocks.call(...args), useApi: () => ({}) }));
const criteria = [[{ kind: "count" as const, name: "WarpPrism", category: "unit" as const, clock: "completion" as const, min: 1, beforeSeconds: 360 }]];
const detail = (): BuildDetail => ({ id: "PvZ - Archon Drop", name: "PvZ - Archon Drop", scope: "preset", owner: null, mode: "rule-only", released: { implementation: "declarative", description: "Real Prism completes by 6:00.", releasedCriteria: criteria, surfaces: ["you"] }, replacement: null, expectedHash: "a".repeat(64), policyRevision: 3, evaluatorVersion: 1, schemaVersion: 1, releaseHash: "b".repeat(64) });
beforeEach(() => { mocks.call.mockReset(); }); afterEach(cleanup);
function editor(value = detail()) { const onSaved = vi.fn(), onReload = vi.fn(async () => {}); return { ...render(<BuildStudioEditor detail={value} onSaved={onSaved} onReload={onReload} />), onSaved, onReload }; }
it("edits the real 6:00 completion gate and requires review before a hash-fenced save", async () => {
  const f = editor(); fireEvent.click(screen.getByText("Released definition and source"));
  fireEvent.click(screen.getByRole("button", { name: "Use actual released criteria as replacement" }));
  const deadline = screen.getByLabelText("Deadline (m:ss)"); expect((deadline as HTMLInputElement).value).toBe("6:00");
  fireEvent.change(deadline, { target: { value: "5:30" } }); fireEvent.blur(deadline);
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = screen.getByRole("dialog", { name: "Review definition changes" });
  expect(dialog.textContent).toContain('"beforeSeconds": 330'); expect(dialog.textContent).toContain("Unclassified"); expect(mocks.call).not.toHaveBeenCalled();
  mocks.call.mockResolvedValueOnce({ ...detail(), policyRevision: 4 }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirm save" }));
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledOnce());
  expect(mocks.call.mock.calls[0][1]).toBe("/v1/admin/build-studio/preset/PvZ%20-%20Archon%20Drop");
  const body = JSON.parse(mocks.call.mock.calls[0][2].body); expect(body.expectedHash).toBe("a".repeat(64)); expect(body.replacement.anyOf[0][0]).toEqual({ ...criteria[0][0], beforeSeconds: 330 });
});
it("retains newer drafts through delayed background data and a conflicting save", async () => {
  const f = editor(); fireEvent.change(screen.getByLabelText("Reference description"), { target: { value: "Keep this newer draft" } });
  f.rerender(<BuildStudioEditor detail={{ ...detail(), expectedHash: "c".repeat(64) }} onSaved={f.onSaved} onReload={f.onReload} />);
  expect((screen.getByLabelText("Reference description") as HTMLTextAreaElement).value).toBe("Keep this newer draft");
  mocks.call.mockRejectedValueOnce({ status: 409, message: "preset_policy_changed" }); fireEvent.click(screen.getByRole("button", { name: "Review changes" })); fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Your draft is preserved"));
  expect((screen.getByLabelText("Reference description") as HTMLTextAreaElement).value).toBe("Keep this newer draft"); expect(f.onSaved).not.toHaveBeenCalled();
  expect(JSON.parse(mocks.call.mock.calls[0][2].body).expectedHash).toBe("a".repeat(64));
});
it("labels procedural presets honestly and previews without saving", async () => {
  editor({ ...detail(), released: { implementation: "procedural", description: "Procedural decision tree.", surfaces: ["you"] } });
  expect(screen.getByText(/No authored steps; this definition is rule-only/)).toBeTruthy(); fireEvent.click(screen.getByText("Released definition and source"));
  expect(screen.getByText(/No authored step list or replacement criteria is implied/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Use actual released criteria as replacement" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Detection behavior"), { target: { value: "replacement" } }); fireEvent.click(screen.getByText("Preview against raw extracted events"));
  mocks.call.mockResolvedValueOnce({ label: "Unclassified - Protoss", hash: "d".repeat(64), evaluatorVersion: 1 }); fireEvent.click(screen.getByRole("button", { name: "Run unsaved preview" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Unclassified - Protoss")); expect(mocks.call.mock.calls[0][1]).toContain("/preview");
});
it("reviews previous private v3 definitions without invented steps or owner mutation", async () => {
  const build = { name: "Private v3", schemaVersion: 3, race: "Protoss", rules: [{ type: "count_min", name: "BuildGateway", count: 1, time_lt: 180 }], steps: [] };
  const value: BuildDetail = { id: "private-id", name: "Private v3", scope: "custom", owner: "owner-2", mode: "rule-only", revision: 9, build, history: [{ revision: 8, savedAt: "2026-10-23", build: { ...build, name: "Previous definition" } }] };
  editor(value); expect(screen.getByText(/owner owner-2/)).toBeTruthy(); expect(screen.getByText(/Rule-only definition: no authored build-order steps exist/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review revision 8" })); const dialog = screen.getByRole("dialog"); expect(dialog.textContent).toContain("Previous definition");
  mocks.call.mockResolvedValueOnce({ ...value, revision: 10 }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirm save" })); await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.call.mock.calls[0][2].body)).toEqual({ expectedRevision: 9, build: { ...build, name: "Previous definition" } });
});
it("restores a preset to released behavior through an explicit new-version review", async () => {
  editor({ ...detail(), replacement: { name: detail().id, priority: 0, enabled: true, anyOf: criteria } }); fireEvent.click(screen.getByRole("button", { name: "Review restore to released" }));
  expect(screen.getByRole("dialog").textContent).toContain("Restore released preset"); mocks.call.mockResolvedValueOnce(detail()); fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce()); expect(JSON.parse(mocks.call.mock.calls[0][2].body)).toEqual({ expectedHash: "a".repeat(64), replacement: null });
});

it("reviews community listing text as well as the full independent snapshot before writing", async () => {
  const value: BuildDetail = { id: "public-id", name: "Public snapshot", scope: "community", owner: "owner-2", sourceSlug: "private-source", removed: true, mode: "rule-only", revision: 2, title: "Original listing", description: "Original listing description", build: { name: "Rule only", race: "Protoss", rules: [], steps: [] } };
  editor(value);
  fireEvent.change(screen.getByLabelText("Listing title"), { target: { value: "Corrected listing title" } });
  fireEvent.change(screen.getByLabelText("Listing description"), { target: { value: "Corrected public description" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Original listing description");
  expect(dialog.textContent).toContain("Corrected listing title");
  expect(dialog.textContent).toContain("Corrected public description");
  expect(mocks.call).not.toHaveBeenCalled();
  mocks.call.mockResolvedValueOnce({ ...value, revision: 3 });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm save" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.call.mock.calls[0][2].body)).toMatchObject({ title: "Corrected listing title", description: "Corrected public description", expectedRevision: 2 });
});
