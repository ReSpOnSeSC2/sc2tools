import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ call: vi.fn(), getToken: vi.fn(async () => "token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.getToken, isLoaded: true, isSignedIn: true, userId: "test-owner" }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: api.call }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "" }));
import { ToastProvider } from "@/components/ui/Toast";
import { EditCustomBuildLauncher } from "./EditCustomBuildLauncher";
import { duplicateBuildName } from "./EditCustomBuildLauncher";

afterEach(() => { cleanup(); api.call.mockReset(); });
describe("saved build editor", () => {
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
