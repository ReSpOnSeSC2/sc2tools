/**
 * ReplayIntake — picker accept rules, drop forwarding (files and whole
 * folders), keyboard access, the folder input and the status line.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLAY_INPUT_ACCEPT, makeIntakeFile } from "@/lib/instant/fileIntake";
import { orderedPathHints } from "../OsPathHints";
import { ReplayIntake, type ReplayIntakeProps } from "../ReplayIntake";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

function renderIntake(overrides: Partial<ReplayIntakeProps> = {}) {
  const props: ReplayIntakeProps = {
    onFiles: vi.fn(),
    dateWindow: { kind: "days90" },
    onDateWindowChange: vi.fn(),
    fileCount: 0,
    ...overrides,
  };
  const view = render(<ReplayIntake {...props} />);
  return { ...view, props };
}

function pickerInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="Replay files"]');
  if (!input) throw new Error("picker input missing");
  return input;
}

function dropZone(): HTMLElement {
  const zone = screen.getByText("Add your replays").parentElement;
  if (!zone) throw new Error("drop zone missing");
  return zone;
}

/** Minimal stand-ins for the entries `DataTransferItem.webkitGetAsEntry()` returns. */
interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (ok: (file: File) => void, fail: (error: Error) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: FakeEntry[]) => void) => void };
}

function fakeFile(fullPath: string, readable = true): FakeEntry {
  const name = fullPath.split("/").pop() ?? fullPath;
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (ok, fail) => (readable ? ok(new File(["r"], name)) : fail(new Error("NotFoundError"))),
  };
}

/** A directory whose reader serves one child per `readEntries` call, then []. */
function fakeDirectory(fullPath: string, children: FakeEntry[]): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader: () => {
      const queue = [...children];
      return {
        readEntries: (ok) => {
          const next = queue.shift();
          ok(next ? [next] : []);
        },
      };
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReplayIntake: picking and dropping files", () => {
  it("filters the picker to replays and zips on desktop", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA);
    const { container } = renderIntake();
    const input = pickerInput(container);
    expect(input.getAttribute("accept")).toBe(REPLAY_INPUT_ACCEPT);
    expect(input.multiple).toBe(true);
  });

  it("drops the accept filter on iOS so .SC2Replay is not greyed out", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    const { container } = renderIntake();
    expect(pickerInput(container).hasAttribute("accept")).toBe(false);
  });

  it("forwards every dropped file to the caller, which owns filtering", () => {
    const { props } = renderIntake();
    const replay = new File(["r"], "a.SC2Replay");
    const notes = new File(["t"], "notes.txt");
    const zone = dropZone();
    fireEvent.dragEnter(zone, { dataTransfer: { files: [replay, notes], dropEffect: "none" } });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(zone, { dataTransfer: { files: [replay, notes] } });
    expect(props.onFiles).toHaveBeenCalledWith([replay, notes], "drop");
    expect(zone.hasAttribute("data-dragging")).toBe(false);
  });

  it("ignores drops while disabled", () => {
    const { props } = renderIntake({ disabled: true });
    fireEvent.drop(dropZone(), { dataTransfer: { files: [new File(["r"], "a.SC2Replay")] } });
    expect(props.onFiles).not.toHaveBeenCalled();
  });

  it("opens the picker from a focusable button and forwards picked files", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const { container, props } = renderIntake();
    const button = screen.getByRole("button", { name: "Choose replays" });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    const input = pickerInput(container);
    const replay = new File(["r"], "a.SC2Replay");
    fireEvent.change(input, { target: { files: [replay] } });
    expect(props.onFiles).toHaveBeenCalledWith([replay], "picker");
  });
});

describe("ReplayIntake: folders, status and hints", () => {
  it("offers a webkitdirectory folder input only when allowed, and Folder Sync only when provided", () => {
    const onPickFolder = vi.fn();
    const { container } = renderIntake({ allowFolderInput: true, onPickFolder });
    const folder = container.querySelector<HTMLInputElement>('input[aria-label="Replay folder"]');
    expect(folder?.hasAttribute("webkitdirectory")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sync a replay folder" }));
    expect(onPickFolder).toHaveBeenCalledTimes(1);
    cleanup();
    renderIntake();
    expect(screen.queryByRole("button", { name: "Choose a folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync a replay folder" })).toBeNull();
  });

  it("shows the file count, estimate and cap, and changes the date window", () => {
    const { props } = renderIntake({ fileCount: 3, estimate: { seconds: 11, label: "about 11 seconds" }, maxFiles: 25 });
    expect(screen.getByRole("status").textContent).toBe("3 replays ready · about 11 seconds to analyze");
    expect(screen.getByText(/Up to 25 replays per run/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("All time"));
    expect(props.onDateWindowChange).toHaveBeenCalledWith({ kind: "all" });
  });

  it("lists Windows and macOS replay folders", () => {
    renderIntake();
    expect(screen.getByText("Documents\\StarCraft II\\Accounts")).toBeTruthy();
    expect(screen.getByText("~/Library/Application Support/Blizzard/StarCraft II/Accounts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the Windows path" })).toBeTruthy();
    expect(orderedPathHints("macos").map((hint) => hint.platform)).toEqual(["macos", "windows"]);
    expect(orderedPathHints("ios").map((hint) => hint.platform)).toEqual(["windows", "macos"]);
  });
});

describe("ReplayIntake: dropping a folder", () => {
  it("walks the folder and keeps each file's path so the toon folder identifies the player", async () => {
    const { props } = renderIntake();
    const toonDir = "/Accounts/1/1-S2-1-267727/Replays/Multiplayer";
    const root = fakeDirectory("/Accounts", [
      fakeDirectory(toonDir, [fakeFile(`${toonDir}/a.SC2Replay`), fakeFile(`${toonDir}/gone.SC2Replay`, false)]),
      fakeFile("/Accounts/Variables.txt"),
    ]);
    const folderPseudoFile = new File([], "Accounts");
    fireEvent.drop(dropZone(), {
      dataTransfer: { files: [folderPseudoFile], items: [{ kind: "file", webkitGetAsEntry: () => root }] },
    });
    expect(screen.getByText("Reading the dropped folder…")).toBeTruthy();
    await waitFor(() => expect(props.onFiles).toHaveBeenCalledTimes(1));
    const [files, source] = vi.mocked(props.onFiles).mock.calls[0];
    expect(source).toBe("drop");
    // Level by level: the root's own files first, then the nested folder's.
    expect(files.map((file) => file.webkitRelativePath)).toEqual([
      "Accounts/Variables.txt",
      "Accounts/1/1-S2-1-267727/Replays/Multiplayer/a.SC2Replay",
    ]);
    expect(makeIntakeFile(files[1], "drop").relativePath).toContain("1-S2-1-267727");
    expect(screen.queryByText("Reading the dropped folder…")).toBeNull();
  });

  it("forwards plain file drops unchanged when no folder is involved", () => {
    const { props } = renderIntake();
    const replay = new File(["r"], "a.SC2Replay");
    const entry = fakeFile("/a.SC2Replay");
    fireEvent.drop(dropZone(), { dataTransfer: { files: [replay], items: [{ kind: "file", webkitGetAsEntry: () => entry }] } });
    expect(props.onFiles).toHaveBeenCalledWith([replay], "drop");
  });
});

describe("ReplayIntake: warm-up intent and focus", () => {
  it("signals intent on a button press, a drag over the zone or focus, never on mount", () => {
    const onIntent = vi.fn();
    renderIntake({ onIntent, allowFolderInput: true });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose replays" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Choose a folder" }), { key: "Enter" });
    fireEvent.dragEnter(dropZone());
    fireEvent.focus(screen.getByRole("button", { name: "Choose replays" }));
    expect(onIntent).toHaveBeenCalledTimes(4);
  });

  it("stays quiet while disabled", () => {
    const onIntent = vi.fn();
    renderIntake({ onIntent, disabled: true });
    fireEvent.dragEnter(dropZone());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose replays" }));
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("moves focus to its heading when focusKey is bumped, without signalling intent", () => {
    const onIntent = vi.fn();
    const { rerender, props } = renderIntake({ onIntent });
    expect(document.activeElement).toBe(document.body);
    rerender(<ReplayIntake {...props} focusKey={1} />);
    expect(document.activeElement?.textContent).toBe("Add your replays");
    expect(onIntent).not.toHaveBeenCalled();
  });
});
