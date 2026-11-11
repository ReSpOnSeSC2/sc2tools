import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent, RefObject } from "react";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  initial: null as unknown,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken, userId: "owner", isLoaded: true, isSignedIn: true }) }));
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  return {
    apiCall: harness.apiCall,
    useApi: () => {
      const [data, setData] = React.useState(harness.initial);
      return {
        data, error: undefined, isLoading: false,
        mutate: async (updater?: unknown) => { if (typeof updater === "function") setData((previous: unknown) => (updater as (value: unknown) => unknown)(previous)); },
      };
    },
  };
});

import { GameNotesPanel } from "../GameNotesPanel";
import { useGameNoteWorkspace } from "../useGameNoteWorkspace";
import { TransportDock } from "@/components/analyzer/game/replay/TransportDock";
// Not a React hook despite its name: it returns a plain key handler.
import { useReplayShortcuts as replayKeyHandler } from "@/lib/useReplayShortcuts";
import type { NoteDto } from "@/lib/notes";

const note = (id: string, text: string, gameTimeSec: number | null, extra: Partial<NoteDto> = {}): NoteDto => ({
  id, target: { kind: "game", id: "g1" }, text, tags: [], visibility: "private", scope: "account", pinned: false, readAloud: false,
  streamEligible: false, migrated: false, gameTimeSec, x: null, y: null, createdAt: `2026-11-01T00:00:0${id.length}.000Z`, updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

function Harness({ onSeek, time = 252, probe }: { onSeek: (t: number) => void; time?: number; probe?: (ws: ReturnType<typeof useGameNoteWorkspace>) => void }) {
  const workspace = useGameNoteWorkspace("g1", onSeek);
  probe?.(workspace);
  return <GameNotesPanel workspace={workspace} currentTime={time} onSeek={onSeek} />;
}

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.initial = { limit: 200, items: [note("late", "Lost the third", 412), note("b", "General note", null), note("early", "Scout here", 95, { x: 10, y: 20 })] };
});
afterEach(() => cleanup());

describe("GameNotesPanel", () => {
  it("lists notes by game time and seeks from a note", () => {
    const onSeek = vi.fn();
    let ws: ReturnType<typeof useGameNoteWorkspace> | undefined;
    render(<Harness onSeek={onSeek} probe={(value) => { ws = value; }} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Scout here"), expect.stringContaining("Lost the third"), expect.stringContaining("General note")]);
    fireEvent.click(screen.getByRole("button", { name: "Jump to 1:35" }));
    expect(onSeek).toHaveBeenCalledWith(95);
    // Timed notes become timeline markers; the pinned one is also a map pin.
    expect(ws!.commentMarkers.map((marker) => marker.label)).toEqual(["Note at 1:35", "Note at 6:52"]);
    expect(ws!.mapMarkers).toEqual([expect.objectContaining({ id: "early", x: 10, y: 20, t: 95, label: "1" })]);
  });

  it("adds a note at the current moment, with a map pin", async () => {
    harness.apiCall.mockImplementation(async (_token: unknown, _path: string, init: RequestInit) => ({ ...note("new1", "Fast expand", 252, { x: 33, y: 44 }), ...JSON.parse(String(init.body)), id: "new1" }));
    let ws: ReturnType<typeof useGameNoteWorkspace> | undefined;
    render(<Harness onSeek={vi.fn()} probe={(value) => { ws = value; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add note at 4:12" }));
    expect(screen.getByText("At 4:12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin on map" }));
    expect(screen.getByRole("button", { name: "Click the map…" }).getAttribute("aria-pressed")).toBe("true");
    act(() => ws!.onWorldClick!(33, 44, 260));
    expect(ws!.mapMarkers.some((marker) => marker.draft && marker.x === 33)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Fast expand" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/games/g1/notes");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Fast expand", tags: [], gameTimeSec: 252, x: 33, y: 44 });
    expect(await screen.findByText(/Note saved at 4:12/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("deletes with Undo that restores the same note", async () => {
    harness.apiCall.mockImplementation(async (_token: unknown, path: string, init: RequestInit) => init.method === "DELETE"
      ? note("late", "Lost the third", 412, { tags: ["Macro"] })
      : { ...note("again", "Lost the third", 412, { tags: ["Macro"] }), ...JSON.parse(String(init.body)), id: "again" });
    render(<Harness onSeek={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete note" })[1]);
    expect(await screen.findByText(/Note at 6:52 deleted/)).toBeTruthy();
    expect(harness.apiCall.mock.calls[0][1]).toBe("/v1/games/g1/notes/late");
    expect(screen.queryByText("Lost the third")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(harness.apiCall.mock.calls[1][2].body))).toEqual({ text: "Lost the third", tags: ["Macro"], pinned: false, gameTimeSec: 412 });
    expect(await screen.findByText("Lost the third")).toBeTruthy();
  });
});

describe("replay dock note entry", () => {
  it("offers Add note at the current time and the B shortcut", () => {
    const onAddNote = vi.fn();
    render(<TransportDock t={252} gameLength={600} playing={false} speed={1} markers={[]} phases={[]} onSeek={vi.fn()} onPlayingChange={vi.fn()} onSpeedChange={vi.fn()} onAddNote={onAddNote} />);
    const button = screen.getByRole("button", { name: "Add note at 4:12" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("B");
    fireEvent.click(button);
    expect(onAddNote).toHaveBeenCalledWith(252);
  });

  it("B opens a note only where the host offers one", () => {
    const root = document.createElement("div");
    const target = document.createElement("span");
    root.append(target); document.body.append(root);
    const base = { root: { current: root } as RefObject<HTMLElement | null>, time: 10, gameLength: 100, playing: false, speed: 1 as const, markers: [],
      onSeek: vi.fn(), onPlay: vi.fn(), onSpeed: vi.fn(), onMusic: vi.fn(), onHelp: vi.fn(), helpOpen: false };
    const press = (handler: (event: KeyboardEvent<HTMLElement>) => void) => {
      const preventDefault = vi.fn();
      handler({ key: "b", target, defaultPrevented: false, nativeEvent: { isComposing: false }, ctrlKey: false, metaKey: false, altKey: false, repeat: false, preventDefault } as unknown as KeyboardEvent<HTMLElement>);
      return preventDefault;
    };
    const onNote = vi.fn();
    expect(press(replayKeyHandler({ ...base, onNote }))).toHaveBeenCalled();
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(press(replayKeyHandler(base))).not.toHaveBeenCalled();
    root.remove();
  });
});
