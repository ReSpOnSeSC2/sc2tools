import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideAdminNote } from "@/lib/guides/types";
import {
  ADMIN_VIDEOS,
  ADMIN_VIDEO_8_POOLS,
  ADMIN_VIDEO_CARRIERS,
  ADMIN_VIDEO_GLAIVES,
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

function serve(notes: GuideAdminNote[] = [glaivesNote()]) {
  harness.responses.set("/v1/admin/guides/notes", { data: { items: notes } });
  harness.responses.set("/v1/admin/guides/status", { data: statusFixture() });
  harness.responses.set("/v1/admin/guides/videos", { data: { items: ADMIN_VIDEOS } });
}

function renderOnGlaives() {
  render(<AdminGuidesPage />);
  fireEvent.change(screen.getByLabelText("Build guide"), { target: { value: STARGATE_GLAIVES } });
  return screen.getByRole("list", { name: "On the PvZ Stargate into Glaives guide" });
}

function expectNotesPut(videos: { pinned: string[]; hidden: string[] }) {
  return waitFor(() =>
    expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, STARGATE_GLAIVES_NOTES_PATH, {
      method: "PUT",
      body: JSON.stringify({ videos }),
    }),
  );
}

beforeEach(() => {
  harness.responses.clear();
  harness.apiCall.mockResolvedValue({ note: glaivesNote() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin Guides per-guide video pin/hide", () => {
  it("lists the matchup's videos with pinned first, then this build's auto matches", () => {
    serve([glaivesNote({ videos: { pinned: [ADMIN_VIDEO_8_POOLS.youtubeId], hidden: [] } })]);
    const list = renderOnGlaives();
    const titles = within(list).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    expect(titles).toEqual([ADMIN_VIDEO_8_POOLS.title, ADMIN_VIDEO_GLAIVES.title, ADMIN_VIDEO_CARRIERS.title]);
    expect(within(list).getAllByText("Auto match")).toHaveLength(1);
  });

  it("pins a video by saving only the video overrides through the notes PUT", async () => {
    serve();
    renderOnGlaives();
    const pin = screen.getByRole("button", { name: `Pin “${ADMIN_VIDEO_GLAIVES.title}”` });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    await expectNotesPut({ pinned: [ADMIN_VIDEO_GLAIVES.youtubeId], hidden: [] });
    expect(harness.mutate).toHaveBeenCalled();
  });

  it("hiding a pinned video on this guide un-pins it", async () => {
    serve([glaivesNote({ videos: { pinned: [ADMIN_VIDEO_GLAIVES.youtubeId], hidden: [] } })]);
    renderOnGlaives();
    expect(screen.getByRole("button", { name: `Pin “${ADMIN_VIDEO_GLAIVES.title}”` }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: `Hide here “${ADMIN_VIDEO_GLAIVES.title}”` }));
    await expectNotesPut({ pinned: [], hidden: [ADMIN_VIDEO_GLAIVES.youtubeId] });
  });

  it("disables pin and hide while the saved notes can't be read (no blind overwrite)", () => {
    serve();
    harness.responses.set("/v1/admin/guides/notes", { error: { status: 500, message: "Something went wrong on our side." } });
    renderOnGlaives();
    expect((screen.getByRole("button", { name: `Pin “${ADMIN_VIDEO_GLAIVES.title}”` }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: `Hide here “${ADMIN_VIDEO_GLAIVES.title}”` }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a failed override save and clears the notice when another build is picked", async () => {
    serve();
    harness.apiCall.mockRejectedValue({ status: 400, code: "invalid_note", message: "a video cannot be both pinned and hidden" });
    renderOnGlaives();
    fireEvent.click(screen.getByRole("button", { name: `Pin “${ADMIN_VIDEO_GLAIVES.title}”` }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save this guide's videos. a video cannot be both pinned and hidden");
    fireEvent.change(screen.getByLabelText("Build guide"), { target: { value: "PvZ - Carrier Rush" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists saved override ids missing from the channel list and clears them", async () => {
    const unknown = "zzzzzzzzzzz";
    serve([glaivesNote({ videos: { pinned: [unknown, ADMIN_VIDEO_GLAIVES.youtubeId], hidden: [] } })]);
    renderOnGlaives();
    expect(screen.getByText(unknown)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear them" }));
    await expectNotesPut({ pinned: [ADMIN_VIDEO_GLAIVES.youtubeId], hidden: [] });
  });

  it("disables pinning past the three-video cap", () => {
    const pinned = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
    serve([glaivesNote({ videos: { pinned, hidden: [] } })]);
    renderOnGlaives();
    const pin = screen.getByRole("button", { name: `Pin “${ADMIN_VIDEO_GLAIVES.title}”` }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
  });
});

describe("admin Guides channel videos", () => {
  it("shows the detected matchup, builds and counters of each video", () => {
    serve();
    render(<AdminGuidesPage />);
    const list = screen.getByRole("list", { name: "Channel videos (4)" });
    expect(within(list).getByText("PvZ · builds: Stargate into Glaives · counters: none")).toBeTruthy();
    expect(within(list).getByText("PvZ · builds: none · counters: none")).toBeTruthy();
  });

  it("hides and unhides a video on every guide with PATCH", async () => {
    serve();
    render(<AdminGuidesPage />);
    fireEvent.click(screen.getByRole("button", { name: `Hide “${ADMIN_VIDEO_GLAIVES.title}” on every guide` }));
    await waitFor(() =>
      expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/admin/guides/videos/YcTMc_Ee11w", {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: `Unhide “${ADMIN_VIDEO_CARRIERS.title}” on guides` }));
    await waitFor(() =>
      expect(harness.apiCall).toHaveBeenLastCalledWith(harness.getToken, "/v1/admin/guides/videos/RYjRs_no8t4", {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      }),
    );
  });

});

describe("admin Guides add video and sync", () => {
  it("adds a video by URL after parsing its id", async () => {
    serve();
    harness.apiCall.mockResolvedValue({ item: ADMIN_VIDEO_8_POOLS });
    render(<AdminGuidesPage />);
    const input = screen.getByLabelText("Add a video by URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://youtu.be/A4x6gR7J-AY?si=share" } });
    fireEvent.click(screen.getByRole("button", { name: "Add video" }));
    await waitFor(() =>
      expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/admin/guides/videos", {
        method: "POST",
        body: JSON.stringify({ youtubeId: "A4x6gR7J-AY" }),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(`Added “${ADMIN_VIDEO_8_POOLS.title}”.`);
    expect(input.value).toBe("");
  });

  it("rejects a non-YouTube URL without calling the API", () => {
    serve();
    render(<AdminGuidesPage />);
    fireEvent.change(screen.getByLabelText("Add a video by URL"), { target: { value: "https://example.com/watch?v=A4x6gR7J-AY" } });
    fireEvent.click(screen.getByRole("button", { name: "Add video" }));
    expect(screen.getByRole("alert").textContent).toContain("Paste a YouTube video link");
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("explains a video from another channel", async () => {
    serve();
    harness.apiCall.mockRejectedValue({ status: 422, code: "video_not_on_channel", message: "Request failed (HTTP 422)." });
    render(<AdminGuidesPage />);
    fireEvent.change(screen.getByLabelText("Add a video by URL"), { target: { value: "dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add video" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't add the video. That video isn't on the configured YouTube channel.");
  });

  it("syncs the channel feed on demand", async () => {
    serve();
    harness.apiCall.mockResolvedValue({ fetched: 15, inserted: 1, updated: 2 });
    render(<AdminGuidesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/admin/guides/videos/sync", { method: "POST" }),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Channel synced: 15 videos in the feed, 1 new, 2 updated.");
  });
});
