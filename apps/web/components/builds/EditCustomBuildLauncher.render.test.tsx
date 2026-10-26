import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ call: vi.fn(), getToken: vi.fn(async () => "token"), owner: "test-owner" as string | null, loaded: true, signedIn: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.getToken, isLoaded: api.loaded, isSignedIn: api.signedIn, userId: api.owner }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: api.call }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "" }));
import { ToastProvider } from "@/components/ui/Toast";
import { EditCustomBuildLauncher } from "./EditCustomBuildLauncher";
import { duplicateBuildName } from "./EditCustomBuildLauncher";

beforeEach(() => { api.owner = "test-owner"; api.loaded = true; api.signedIn = true; api.getToken.mockReset().mockResolvedValue("token"); });
afterEach(() => { cleanup(); api.call.mockReset(); vi.useRealTimers(); });
describe("saved build editor", () => {
  it("offers a named, cancellable pending dialog and restores the launcher focus", async () => {
    api.call.mockImplementation(() => new Promise(() => {}));
    const close = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Edit saved build</button>{open ? <EditCustomBuildLauncher build={{ slug: "fixture", name: "Fixture", race: "Protoss" }} onClose={() => { close(); setOpen(false); }} onSaved={vi.fn()} /> : null}</>;
    }
    render(<Host />); const launch = screen.getByRole("button", { name: "Edit saved build" }); launch.focus(); fireEvent.click(launch);
    const dialog = screen.getByRole("dialog", { name: "Edit build" }); expect(dialog.className).toContain("sm:max-w-4xl");
    expect(screen.getByRole("status").parentElement?.getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(launch));
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it.each(["token", "body"])("bounds a held %s at 20s, settles busy state and retries without accepting the old attempt", async held => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    if (held === "token") {
      api.getToken.mockImplementation(() => new Promise<string>(() => {}));
      api.call.mockImplementation(async getToken => { await getToken(); return {}; });
    } else api.call.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const doc = { slug: "fixture", name: "Current opening", race: "Protoss" as const, notes: "Current private note" };
    render(<ToastProvider><EditCustomBuildLauncher build={doc} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole("alert").textContent).toMatch(/too long|load/i);
    expect(screen.getByRole("alert").parentElement?.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    vi.useRealTimers(); api.getToken.mockResolvedValue("token"); api.call.mockResolvedValue(doc);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByDisplayValue("Current opening (copy)");
    if (release) await act(async () => release({ ...doc, name: "Retired opening", notes: "Retired private note" }));
    expect(screen.queryByDisplayValue(/Retired/)).toBeNull(); expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("shows recoverable failure without busy state and opens only the existing rich editor after retry", async () => {
    let failing = true;
    const doc = { slug: "fixture", name: "Fixture", race: "Protoss" as const };
    api.call.mockImplementation(async (_token, path) => {
      if (failing) throw { message: "Synthetic unavailable" };
      return path.includes("my-build-publication") ? { published: false, authorName: "", publishAnonymously: false, mirrorPending: false } : doc;
    });
    render(<ToastProvider><EditCustomBuildLauncher build={doc} onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    expect((await screen.findByRole("alert")).parentElement?.getAttribute("aria-busy")).toBe("false");
    failing = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText(/^Name/); expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByText("Loading build…")).toBeNull();
  });

  it("returns to the Library opener after an error retries into the ready editor", async () => {
    let failing = true;
    const doc = { slug: "fixture", name: "Fixture", race: "Protoss" as const };
    api.call.mockImplementation(async (_token, path) => {
      if (path.includes("my-build-publication")) return { published: false, authorName: "", publishAnonymously: false, mirrorPending: false };
      if (failing) throw { status: 503, message: "Synthetic unavailable" };
      return doc;
    });
    function Host() {
      const [open, setOpen] = useState(false);
      return <ToastProvider><button onClick={() => setOpen(true)}>Library opener</button>{open ? <EditCustomBuildLauncher build={doc} onClose={() => setOpen(false)} onSaved={vi.fn()} /> : null}</ToastProvider>;
    }
    render(<Host />);
    const launch = screen.getByRole("button", { name: "Library opener" });
    launch.focus(); fireEvent.click(launch);
    await screen.findByRole("alert");
    failing = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText(/^Name/);
    const close = within(screen.getByRole("dialog")).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(launch));
  });

  it("retires held resource and account-ABA deliveries before showing private editor data", async () => {
    const pending: Array<(value: unknown) => void> = [];
    api.call.mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
    const first = { slug: "first", name: "First owner note", race: "Protoss" as const };
    const second = { slug: "second", name: "Current owner note", race: "Protoss" as const };
    const view = render(<ToastProvider><EditCustomBuildLauncher build={first} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    view.rerender(<ToastProvider><EditCustomBuildLauncher build={second} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    api.owner = "other-owner"; view.rerender(<ToastProvider><EditCustomBuildLauncher build={second} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    api.owner = "test-owner"; view.rerender(<ToastProvider><EditCustomBuildLauncher build={second} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    expect(pending).toHaveLength(4);
    await act(async () => { pending[3](second); }); await screen.findByDisplayValue("Current owner note (copy)");
    await act(async () => { pending.slice(0, 3).forEach(resolve => resolve({ ...first, name: "Retired private data" })); });
    expect(screen.queryByDisplayValue(/Retired/)).toBeNull();
    api.loaded = false; view.rerender(<ToastProvider><EditCustomBuildLauncher build={second} intent="duplicate" onClose={vi.fn()} onSaved={vi.fn()} /></ToastProvider>);
    expect(screen.queryByDisplayValue("Current owner note (copy)")).toBeNull();
  });

  it("duplicates a legacy signature privately into a create-only slug, preserving notes and provenance", async () => {
    const doc = { slug: "legacy", name: "Legacy opener", race: "Protoss" as const, notes: "Private scouting tell", sourceReplayId: "source-game", signature: [{ unit: "Gateway", count: 2, beforeSec: 100 }], isPublic: true, winConditions: ["Keep expanding"] };
    api.call.mockImplementation(async (_token, _path, options) => options?.method === "PUT" ? { saved: true, reclassify: null } : doc);
    const saved = vi.fn();
    render(<ToastProvider><EditCustomBuildLauncher build={doc} intent="duplicate" onClose={vi.fn()} onSaved={saved} /></ToastProvider>);
    expect((await screen.findByLabelText(/^Name/) as HTMLInputElement).value).toBe("Legacy opener (copy)");
    expect((screen.getByRole("textbox", { name: "Personal notes (private)" }) as HTMLTextAreaElement).value).toBe("Private scouting tell");
    const save = screen.getByRole("button", { name: "Save build" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const request = api.call.mock.calls.find((call) => call[2]?.method === "PUT")!;
    expect(request[1]).toBe("/v1/custom-builds/legacy-opener-copy");
    expect(JSON.parse(request[2].body)).toMatchObject({ createOnly: true, shareWithCommunity: false, notes: doc.notes, signature: doc.signature, sourceGameId: "source-game", winConditions: ["Keep expanding"], rules: [] });
    expect(api.call.mock.calls.some((call) => call[1].includes("my-build-publication"))).toBe(false);
    expect(screen.getByText("Duplicated as “Legacy opener (copy)”.")).toBeTruthy();
  });

  it("keeps a duplicate draft after 409 so renaming can create it safely", async () => {
    const doc = { slug: "original", name: "Original", race: "Protoss" as const, rules: [{ type: "before" as const, name: "BuildGateway", time_lt: 100 }], notes: "Keep this note" };
    let puts = 0;
    api.call.mockImplementation(async (_token, _path, options) => {
      if (options?.method !== "PUT") return doc;
      if (++puts === 1) throw { status: 409, code: "slug_taken", message: "Taken" };
      return { saved: true, reclassify: null };
    });
    const saved = vi.fn();
    render(<ToastProvider><EditCustomBuildLauncher build={doc} intent="duplicate" onClose={vi.fn()} onSaved={saved} /></ToastProvider>);
    await screen.findByLabelText(/^Name/);
    fireEvent.click(screen.getByRole("button", { name: "Save build" }));
    expect(await screen.findByText("You already have a build called that — pick another name")).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "My second variant" } });
    fireEvent.click(screen.getByRole("button", { name: "Save build" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const putsMade = api.call.mock.calls.filter((call) => call[2]?.method === "PUT");
    expect(putsMade.map((call) => call[1])).toEqual(["/v1/custom-builds/original-copy", "/v1/custom-builds/my-second-variant"]);
    expect(JSON.parse(putsMade[1][2].body)).toMatchObject({ notes: doc.notes, rules: doc.rules, createOnly: true, shareWithCommunity: false });
  });

  it("bounds duplicate names and increments an existing copy suffix", () => {
    expect(duplicateBuildName("Original")).toBe("Original (copy)");
    expect(duplicateBuildName("Original (copy)")).toBe("Original (copy 2)");
    expect(duplicateBuildName("Original (copy 2)")).toBe("Original (copy 3)");
    expect(duplicateBuildName("x".repeat(120))).toHaveLength(120);
  });
  it("seeds existing private notes before PUT, keeps the saved signature absent from the patch, and uses global toasts", async () => {
    const doc = { slug: "legacy", name: "Legacy opener", race: "Protoss" as const, notes: "Private scouting tell", signature: [{ unit: "Gateway", count: 1, beforeSec: 100 }] };
    api.call.mockImplementation(async (_token, path, options) => {
      if (path.includes("my-build-publication")) return { published: false, authorName: "Owner", publishAnonymously: false, mirrorPending: false };
      if (options?.method === "PUT") return { saved: true, reclassify: null };
      return doc;
    });
    const saved = vi.fn();
    render(<ToastProvider><EditCustomBuildLauncher build={doc} onClose={vi.fn()} onSaved={saved} initialFocus="notes" /></ToastProvider>);
    const notes = await screen.findByRole("textbox", { name: "Personal notes (private)" }) as HTMLTextAreaElement;
    expect(notes.value).toBe("Private scouting tell");
    await waitFor(() => expect(document.activeElement).toBe(notes));
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "Public description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const request = api.call.mock.calls.find((call) => call[2]?.method === "PUT")!;
    expect(request[1]).toBe("/v1/custom-builds/legacy");
    const body = JSON.parse(request[2].body);
    expect(body).toMatchObject({ notes: "Private scouting tell", description: "Public description", rules: [] });
    expect(body).not.toHaveProperty("signature");
    expect(screen.queryByRole("region", { name: "Build editor notifications" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Notifications" })).getByRole("link", { name: "View build" }).getAttribute("href")).toBe("/builds/legacy");
  });
});
