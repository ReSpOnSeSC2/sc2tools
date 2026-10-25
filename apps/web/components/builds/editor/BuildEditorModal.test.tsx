import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, userId: "test-owner", isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/lib/clientApi", async original => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: () => ({ data: undefined, error: undefined, isLoading: false }),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: harness.toast }),
  useToastOptional: () => ({ toast: harness.toast }),
}));

import { BuildEditorModal } from "./BuildEditorModal";

afterEach(() => {
  cleanup();
  harness.apiCall.mockReset();
  vi.restoreAllMocks();
});

describe("BuildEditorModal safeguards", () => {
  it("cannot close a newly opened draft through a previous save's delayed callback", async () => {
    harness.apiCall.mockResolvedValue({ saved: true, reclassify: null });
    function Parent() {
      const [open, setOpen] = useState(true);
      const [version, setVersion] = useState(1);
      return <><button onClick={() => { setVersion(2); setOpen(true); }}>Open another draft</button><BuildEditorModal open={open} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} events={[]} race="Protoss" vsRace="Zerg" mode="edit" lockedSlug="legacy" initialDraft={{ name: `Draft ${version}` }} /></>;
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open another draft" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Second unsaved draft" } });
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Second unsaved draft");
  });
  it("closes a clean draft immediately and never registers beforeunload", () => {
    const add = vi.spyOn(window, "addEventListener");
    const onClose = vi.fn();
    renderEditor({ onClose });
    fireEvent.keyDown(screen.getByLabelText(/^Name/), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.some(([name]) => name === "beforeunload")).toBe(false);
  });

  it("guards Escape, focuses Keep editing, scopes confirmation Escape and discards explicitly", async () => {
    const onClose = vi.fn();
    renderEditor({ onClose });
    const name = screen.getByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: "Unsaved variant" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Discard changes to “Unsaved variant”?" })).toBeTruthy();
    const keep = screen.getByRole("button", { name: "Keep editing" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.keyDown(keep, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("guards the scrim and removes beforeunload when changes are reverted", () => {
    const onClose = vi.fn();
    const remove = vi.spyOn(window, "removeEventListener");
    renderEditor({ onClose });
    const name = screen.getByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: "Unsaved variant" } });
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.change(name, { target: { value: "Zerg build vs Protoss" } });
    expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it("lets the landing demo close without guarding local edits", () => {
    const onClose = vi.fn();
    renderEditor({ onClose, demoMode: true });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Demo changes" } });
    fireEvent.keyDown(screen.getByLabelText(/^Name/), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("seeds private notes, focuses them on request and warns about a legacy signature", async () => {
    renderEditor({ mode: "edit", lockedSlug: "legacy", legacySignature: true, initialFocus: "notes", initialDraft: { notes: "Scout the third" } });
    const notes = screen.getByRole("textbox", { name: "Personal notes (private)" }) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(notes));
    expect(notes.value).toBe("Scout the third");
    expect(notes.maxLength).toBe(8000);
    expect(screen.getByRole("note").textContent).toContain("Until you add one, it keeps matching by its signature.");
    fireEvent.change(notes, { target: { value: "x".repeat(7001) } });
    expect(screen.getByRole("status", { name: "Personal notes character count" }).textContent).toBe("7001/8000");
  });

  it("focuses match preview when editing rules and closes a successful metadata save without a prompt", async () => {
    harness.apiCall.mockResolvedValue({ saved: true, reclassify: null });
    const onClose = vi.fn();
    renderEditor({ onClose, mode: "edit", lockedSlug: "legacy", initialFocus: "preview" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Match preview" })));
    fireEvent.change(screen.getByRole("textbox", { name: "Personal notes (private)" }), { target: { value: "Saved scouting note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    const call = harness.apiCall.mock.calls.find((entry) => entry[2]?.method === "PUT")!;
    expect(JSON.parse(call[2].body)).toMatchObject({ notes: "Saved scouting note", rules: [] });
    expect(JSON.parse(call[2].body)).not.toHaveProperty("signature");
  });
});

function renderEditor(props: Partial<ComponentProps<typeof BuildEditorModal>> = {}) {
  return render(
    <BuildEditorModal
      open
      onClose={vi.fn()}
      events={[{ time: 20, name: "Gateway", is_building: true }]}
      race="Zerg"
      vsRace="Protoss"
      perspective="opponent"
      defaultName="Zerg build vs Protoss"
      {...props}
    />,
  );
}

function basics() {
  return screen.getByRole("region", { name: "Basics" });
}

describe("BuildEditorModal matchup lock", () => {
  it("keeps race and vs race editable by default", () => {
    renderEditor();
    const section = basics();
    const race = within(section).getByLabelText("Race") as HTMLSelectElement;
    expect(race.tagName).toBe("SELECT");
    expect(Array.from(race.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Terran",
      "Zerg",
      "Random",
    ]);
    const vsRace = within(section).getByLabelText("Vs race") as HTMLSelectElement;
    expect(Array.from(vsRace.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Terran",
      "Zerg",
      "Random",
      "Any",
    ]);
  });

  it("shows the game's race read-only and only its opponent race or Any", () => {
    renderEditor({ lockMatchup: true });
    const section = basics();
    const race = within(section).getByLabelText("Race") as HTMLInputElement;
    expect(race.tagName).toBe("INPUT");
    expect(race.readOnly).toBe(true);
    expect(race.value).toBe("Zerg");
    expect(within(section).getByText("Set by this game.")).toBeTruthy();
    const vsRace = within(section).getByLabelText("Vs race") as HTMLSelectElement;
    expect(Array.from(vsRace.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Any",
    ]);
    expect(vsRace.value).toBe("Protoss");
    expect(within(section).getByText("Only Protoss or Any fits this game.")).toBeTruthy();
    expect(
      (within(section).getByLabelText(/^Name/) as HTMLInputElement).value,
    ).toBe("Zerg build vs Protoss");
  });

  it("saves create-only with the locked matchup and shows a taken name on the field", async () => {
    harness.apiCall.mockRejectedValueOnce({
      status: 409,
      code: "slug_taken",
      message: "slug_taken",
    });
    const onSaved = vi.fn();
    renderEditor({ lockMatchup: true, createOnly: true, gameId: "g1", onSaved });
    fireEvent.change(screen.getByLabelText("Vs race"), { target: { value: "Any" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Add rule: / })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save build" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalled());
    const saveCall = harness.apiCall.mock.calls.find(
      (call) => (call[2] as RequestInit | undefined)?.method === "PUT",
    )!;
    expect(saveCall[1]).toBe("/v1/custom-builds/zerg-build-vs-protoss");
    expect(JSON.parse(String((saveCall[2] as RequestInit).body))).toMatchObject({
      race: "Zerg",
      vsRace: "Any",
      perspective: "opponent",
      sourceGameId: "g1",
      createOnly: true,
    });
    expect(
      (await within(basics()).findByRole("alert")).textContent,
    ).toBe("You already have a build called that — pick another name");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
