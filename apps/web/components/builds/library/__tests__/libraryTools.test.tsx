import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomBuild } from "../../types";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  responses: {} as Record<string, unknown>,
  mutate: vi.fn(),
  toast: { success: vi.fn((..._args: unknown[]) => "toast-1"), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => ({
    data: path ? harness.responses[path] : undefined,
    error: undefined,
    isLoading: !!path && harness.responses[path] === undefined,
    mutate: harness.mutate,
  }),
}));

import { useBuildLibraryTools } from "../useBuildLibraryTools";
import { ImportBuildsDialog } from "../ImportBuildsDialog";

const builds: CustomBuild[] = [
  { slug: "gate-expand", name: "Gate Expand", race: "Protoss", vsRace: "Zerg", isPublic: true, tags: ["Macro"] },
  { slug: "proxy-two", name: "Proxy Two", race: "Protoss", vsRace: "Terran" },
  {
    slug: "saved-copy", name: "Saved copy", race: "Protoss", vsRace: "Zerg",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    forkedFrom: { communitySlug: "author-build", version: "1", savedAt: "2026-10-01T00:00:00.000Z" },
  },
];

function Harness({ refresh = vi.fn() }: { refresh?: () => void }) {
  const tools = useBuildLibraryTools({ items: builds, refresh });
  return (
    <>
      {tools.toolbar}
      <button type="button" onClick={() => tools.announceDeleted([builds[0]])}>Simulate delete</button>
      <ul>
        {builds.map((build) => {
          const props = tools.cardProps(build);
          return (
            <li key={build.slug} data-testid={`card-${build.slug}`}>
              {props.selection ? (
                <button type="button" aria-pressed={props.selection.selected} onClick={() => props.selection?.onToggle(build.slug)}>Select {build.name}</button>
              ) : null}
              {props.extraMenuItems.map((item) => <button key={item.key} type="button" onClick={item.onClick}>{item.label}</button>)}
              {props.authorUpdate ? <button type="button" onClick={props.authorUpdate.onReview}>Author updated</button> : null}
            </li>
          );
        })}
      </ul>
      {tools.overlays}
    </>
  );
}

const bodyOf = (call: unknown[]) => JSON.parse(String((call[2] as RequestInit).body));

beforeEach(() => {
  harness.responses = {
    "/v1/custom-builds/trash": {
      items: [{ slug: "old-one", name: "Old One", race: "Zerg", vsRace: "Terran", perspective: "you", deletedAt: "2026-11-01T00:00:00.000Z", purgeAt: "2026-12-01T00:00:00.000Z" }],
      total: 1,
      retentionDays: 30,
    },
    "/v1/community/builds/versions?slugs=author-build": { items: [{ slug: "author-build", version: 2, updatedAt: "2026-11-05T00:00:00.000Z" }] },
    "/v1/community/builds/author-build": { slug: "author-build", version: 2, build: { race: "Protoss", vsRace: "Zerg", rules: [{ type: "before", name: "BuildStargate", time_lt: 200 }] } },
  };
  harness.apiCall.mockReset().mockResolvedValue({});
  harness.toast.success.mockClear();
  harness.toast.error.mockClear();
  harness.toast.info.mockClear();
  harness.toast.dismiss.mockClear();
});

afterEach(cleanup);

describe("build library tools", () => {
  it("offers Undo for 10 s after a delete and restores a published build privately", async () => {
    const refresh = vi.fn();
    render(<Harness refresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Simulate delete" }));
    expect(harness.toast.success).toHaveBeenCalledWith("Deleted “Gate Expand”", expect.objectContaining({ duration: 10_000 }));
    const { description } = harness.toast.success.mock.calls[0][1] as { description: ReactElement };
    render(<>{description}</>);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenLastCalledWith("Restored privately. Publish again to relist it."));
    expect(harness.toast.dismiss).toHaveBeenCalledWith("toast-1");
    expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/custom-builds/gate-expand/restore", { method: "POST", body: "{}" });
    expect(refresh).toHaveBeenCalled();
  });

  it("lists Recently deleted (n) and restores from it", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Recently deleted (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Recently deleted" });
    expect(within(dialog).getByText("Old One")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore Old One" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/custom-builds/old-one/restore", { method: "POST", body: "{}" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Restored “Old One”"));
  });

  it("pins a build and copies a share link that keeps the code in the fragment", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Harness />);
    const card = screen.getByTestId("card-proxy-two");
    fireEvent.click(within(card).getByRole("button", { name: "Pin to top" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/custom-builds/proxy-two/meta", { method: "PATCH", body: JSON.stringify({ pinned: true }) }));
    fireEvent.click(within(card).getByRole("button", { name: "Copy share code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(String(writeText.mock.calls[0][0])).toMatch(/\/builds\/import#code=[A-Za-z0-9_-]+$/);
    expect(harness.toast.success).toHaveBeenLastCalledWith("Share link copied", expect.anything());
  });

  it("selects builds and applies a tag and a single-confirmation delete to them", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Gate Expand" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Proxy Two" }));
    const bar = await screen.findByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Tags…" }));
    fireEvent.change(within(bar).getByLabelText("Tag"), { target: { value: "cheese" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Add to 2" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(harness.apiCall.mock.calls.map((call) => [call[1], bodyOf(call)])).toEqual([
      ["/v1/custom-builds/gate-expand/meta", { tags: ["Macro", "cheese"] }],
      ["/v1/custom-builds/proxy-two/meta", { tags: ["cheese"] }],
    ]);

    harness.apiCall.mockClear();
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete 2 builds?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete builds" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenLastCalledWith("Deleted 2 builds", expect.objectContaining({ duration: 10_000 })));
    expect(harness.apiCall.mock.calls.map((call) => call[1])).toEqual(["/v1/custom-builds/gate-expand", "/v1/custom-builds/proxy-two"]);
  });

  it("flags an author update on a saved copy and applies it from the review", async () => {
    render(<Harness />);
    expect(within(screen.getByTestId("card-gate-expand")).queryByRole("button", { name: "Author updated" })).toBeNull();
    fireEvent.click(within(screen.getByTestId("card-saved-copy")).getByRole("button", { name: "Author updated" }));
    const dialog = await screen.findByRole("dialog", { name: "Review update" });
    expect(within(dialog).getByText(/Changed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply update" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/custom-builds/saved-copy/apply-update", { method: "POST", body: "{}" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenLastCalledWith("Updated “Saved copy” to the author's latest version"));
  });

  it("dismisses an author update by acknowledging its version", async () => {
    render(<Harness />);
    fireEvent.click(within(screen.getByTestId("card-saved-copy")).getByRole("button", { name: "Author updated" }));
    const dialog = await screen.findByRole("dialog", { name: "Review update" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/custom-builds/saved-copy/dismiss-update", { method: "POST", body: JSON.stringify({ version: 2 }) }));
  });
});

describe("ImportBuildsDialog", () => {
  it("previews new, conflicting and invalid builds and imports with the chosen conflict handling", async () => {
    const onImported = vi.fn();
    const onClose = vi.fn();
    harness.apiCall
      .mockResolvedValueOnce({ results: [{ index: 0, status: "new" }, { index: 1, status: "conflict" }], libraryCount: 3 })
      .mockResolvedValueOnce({ results: [{ index: 0, status: "created" }, { index: 1, status: "overwritten" }], libraryCount: 4 });
    render(<ImportBuildsDialog open onClose={onClose} onImported={onImported} />);
    const source = JSON.stringify({ builds: [
      { name: "Fresh", race: "Terran" },
      { slug: "gate-expand", name: "Gate Expand", race: "Protoss" },
      { name: "Broken", race: "Elf" },
    ] });
    fireEvent.change(screen.getByLabelText("Share code or JSON"), { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("status")).textContent).toBe("1 new · 1 already in your library · 1 invalid");
    expect(bodyOf(harness.apiCall.mock.calls[0])).toEqual(expect.objectContaining({ dryRun: true }));
    expect(bodyOf(harness.apiCall.mock.calls[0]).items).toHaveLength(2);
    expect(screen.getByText(/Race must be/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 build" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "When “Gate Expand” is already in your library" }), { target: { value: "overwrite" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 2 builds" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("Imported 2 builds (1 overwritten)."));
    const sent = bodyOf(harness.apiCall.mock.calls[1]);
    expect(sent.reclassify).toBe(true);
    expect(sent.items.map((item: { onConflict: string }) => item.onConflict)).toEqual(["skip", "overwrite"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("marks an unreadable share code invalid without asking the server", async () => {
    render(<ImportBuildsDialog open initialSource="not-a-valid-code!" onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => {});
    expect(screen.getByText("Invalid")).toBeTruthy();
    expect(screen.getByText("That isn't a share code.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nothing to import" }).hasAttribute("disabled")).toBe(true);
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("explains a full library", async () => {
    harness.apiCall
      .mockResolvedValueOnce({ results: [{ index: 0, status: "new" }], libraryCount: 500 })
      .mockRejectedValueOnce({ status: 409, code: "library_full", message: "library_full" });
    render(<ImportBuildsDialog open initialSource={JSON.stringify({ name: "One more", race: "Zerg" })} onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 build" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can hold 500 builds/);
  });
});
