import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideAdminNote } from "@/lib/guides/types";
import { guideBuildOptions } from "@/lib/guides/slugs";
import {
  ADMIN_VIDEOS,
  STARGATE_GLAIVES,
  STARGATE_GLAIVES_NOTES_PATH,
  glaivesNote,
  statusFixture,
} from "./adminGuidesFixtures";

type Resp = { data?: unknown; error?: { status: number; message: string } };

const harness = vi.hoisted(() => ({
  responses: new Map<string, Resp>(),
  apiCall: vi.fn(),
  mutate: vi.fn(async () => undefined),
  getToken: vi.fn(async () => "admin-token"),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    const r = harness.responses.get(path) ?? {};
    return { data: r.data, error: r.error, isLoading: false, mutate: harness.mutate };
  },
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
}));

import AdminGuidesPage from "../page";

function serve(notes: GuideAdminNote[] = []) {
  harness.responses.set("/v1/admin/guides/notes", { data: { items: notes } });
  harness.responses.set("/v1/admin/guides/status", { data: statusFixture() });
  harness.responses.set("/v1/admin/guides/videos", { data: { items: ADMIN_VIDEOS } });
}

function pickGlaives() {
  fireEvent.change(screen.getByLabelText("Build guide"), { target: { value: STARGATE_GLAIVES } });
  return screen.getByLabelText("Notes for Stargate into Glaives (markdown)") as HTMLTextAreaElement;
}

beforeEach(() => {
  harness.responses.clear();
  harness.apiCall.mockResolvedValue({ note: glaivesNote() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin Guides page access", () => {
  it("renders the ForbiddenCard when the admin API answers 403", () => {
    const forbidden = { error: { status: 403, message: "You don't have permission for that." } };
    for (const path of ["/v1/admin/guides/notes", "/v1/admin/guides/status", "/v1/admin/guides/videos"]) {
      harness.responses.set(path, forbidden);
    }
    render(<AdminGuidesPage />);
    expect(screen.getByText("403 — admin only")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Coach's notes" })).toBeNull();
  });

  it("renders the ForbiddenCard when any one admin read answers 403", () => {
    serve();
    harness.responses.set("/v1/admin/guides/status", { error: { status: 403, message: "You don't have permission for that." } });
    render(<AdminGuidesPage />);
    expect(screen.getByText("403 — admin only")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("notes that the public pages are off when the guides flag is off", () => {
    serve();
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    try {
      render(<AdminGuidesPage />);
      expect(screen.getByRole("note").textContent).toContain("NEXT_PUBLIC_GUIDES_ENABLED");
      expect(screen.queryByRole("link", { name: "View the public guide" })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders every section for an admin", () => {
    serve();
    render(<AdminGuidesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Guides" })).toBeTruthy();
    for (const name of ["Coach's notes", "Videos", "Stats runs"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
  });
});

describe("admin Guides coach's notes", () => {
  it("lists the matchup's catalog builds and resets the build on a matchup switch", () => {
    serve();
    render(<AdminGuidesPage />);
    fireEvent.change(screen.getByLabelText("Matchup"), { target: { value: "ZvT" } });
    const build = screen.getByLabelText("Build guide") as HTMLSelectElement;
    const expected = guideBuildOptions("ZvT").map((o) => o.name);
    expect(Array.from(build.options).map((o) => o.value)).toEqual(expected);
    expect(build.value).toBe(expected[0]);
  });

  it("saves the draft with PUT to the build's admin notes path", async () => {
    serve();
    render(<AdminGuidesPage />);
    const textarea = pickGlaives();
    expect(textarea.maxLength).toBe(4000);
    fireEvent.change(textarea, { target: { value: "### Plan\n- Chrono the first Adepts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, STARGATE_GLAIVES_NOTES_PATH, {
      method: "PUT",
      body: JSON.stringify({ body: "### Plan\n- Chrono the first Adepts" }),
    });
    expect(harness.mutate).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toBe("Saved the coach's notes for Stargate into Glaives.");
  });

  it("shows the API's validation message when a save fails", async () => {
    serve();
    harness.apiCall.mockRejectedValue({ status: 400, code: "invalid_note", message: "/body must NOT have more than 4000 characters" });
    render(<AdminGuidesPage />);
    fireEvent.change(pickGlaives(), { target: { value: "Too long" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't save the notes. /body must NOT have more than 4000 characters");
  });

  it("loads the stored note and deletes it only after confirmation", async () => {
    serve([glaivesNote()]);
    render(<AdminGuidesPage />);
    expect(pickGlaives().value).toBe("### Plan\n- Scout before the third");
    expect((screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete notes" }));
    expect(harness.apiCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete notes" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, STARGATE_GLAIVES_NOTES_PATH, { method: "DELETE" }));
    expect((await screen.findByRole("status")).textContent).toBe("Deleted the coach's notes for Stargate into Glaives.");
  });

  it("links to the public guide only when the guides flag is on", () => {
    serve([glaivesNote()]);
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
    try {
      render(<AdminGuidesPage />);
      pickGlaives();
      const link = screen.getByRole("link", { name: "View the public guide" });
      expect(link.getAttribute("href")).toBe("/guides/pvz/stargate-into-glaives");
      expect(screen.getByRole("option", { name: `${STARGATE_GLAIVES} · has notes` })).toBeTruthy();
      expect(screen.queryByRole("note")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

});

describe("admin Guides coach's notes drafts", () => {
  it("locks the editor when the saved notes failed to load, so a save can't overwrite them", () => {
    serve();
    harness.responses.set("/v1/admin/guides/notes", { error: { status: 500, message: "Something went wrong on our side." } });
    render(<AdminGuidesPage />);
    expect(screen.getByText(/Couldn't load saved notes/)).toBeTruthy();
    expect(pickGlaives().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks the editor until the saved notes arrive", () => {
    serve();
    harness.responses.delete("/v1/admin/guides/notes");
    render(<AdminGuidesPage />);
    expect(pickGlaives().disabled).toBe(true);
  });

  it("reverting an edit clears the unsaved state; discard restores the stored text", () => {
    serve([glaivesNote()]);
    render(<AdminGuidesPage />);
    const textarea = pickGlaives();
    const save = screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement;
    fireEvent.change(textarea, { target: { value: "Edited" } });
    expect(save.disabled).toBe(false);
    expect(screen.getByRole("option", { name: `${STARGATE_GLAIVES} · has notes · unsaved` })).toBeTruthy();
    fireEvent.change(textarea, { target: { value: glaivesNote().body } });
    expect(save.disabled).toBe(true);
    expect(screen.getByRole("option", { name: `${STARGATE_GLAIVES} · has notes` })).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "Edited again" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(textarea.value).toBe(glaivesNote().body);
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("keeps an unsaved draft per build while switching builds", () => {
    serve();
    render(<AdminGuidesPage />);
    fireEvent.change(pickGlaives(), { target: { value: "Draft text" } });
    fireEvent.change(screen.getByLabelText("Build guide"), { target: { value: "PvZ - Carrier Rush" } });
    expect((screen.getByLabelText("Notes for Carrier Rush (markdown)") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("option", { name: `${STARGATE_GLAIVES} · unsaved` })).toBeTruthy();
    expect(pickGlaives().value).toBe("Draft text");
  });
});

describe("admin Guides notes preview", () => {
  it("renders the markdown subset with the public renderer and never raw HTML", () => {
    serve();
    render(<AdminGuidesPage />);
    const source = [
      "### Game plan",
      "**Chrono** the *Adepts* <img src=x onerror=\"alert(1)\">",
      "",
      "- [Liquipedia](https://liquipedia.net/starcraft2)",
      "- [bad](javascript:alert(1))",
    ].join("\n");
    fireEvent.change(pickGlaives(), { target: { value: source } });
    const preview = screen.getByTestId("guide-notes-preview");
    expect(within(preview).getByRole("heading", { level: 3, name: "Game plan" })).toBeTruthy();
    expect(preview.querySelector("strong")?.textContent).toBe("Chrono");
    expect(preview.querySelector("em")?.textContent).toBe("Adepts");
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("<img src=x onerror=\"alert(1)\">");
    const links = within(preview).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://liquipedia.net/starcraft2");
    expect(links[0].getAttribute("rel")).toBe("nofollow noopener");
    expect(preview.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("shows a placeholder for an empty draft", () => {
    serve();
    render(<AdminGuidesPage />);
    pickGlaives();
    expect(within(screen.getByTestId("guide-notes-preview")).getByText("Nothing to preview yet.")).toBeTruthy();
  });
});
