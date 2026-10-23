import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ call: vi.fn(), getToken: vi.fn(async () => "token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.getToken }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: api.call }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "" }));
import { ToastProvider } from "@/components/ui/Toast";
import { EditCustomBuildLauncher } from "./EditCustomBuildLauncher";

afterEach(() => { cleanup(); api.call.mockReset(); });
describe("saved build editor", () => {
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
