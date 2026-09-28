import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_PICKER_ID,
  MIN_AUTO_SCAN_INTERVAL_MS,
  YIELD_EVERY_ENTRIES,
  filesFromDirectoryInput,
  isDirectoryHandle,
  pickReplaysFolder,
  queryReadPermission,
  requestReadPermission,
  shouldAutoScan,
  supportsDirectoryPicker,
  walkMultiplayerReplays,
  type DirectoryHandleLike,
  type FileHandleLike,
} from "../folderSync";
import { toonFromPath } from "../toonPath";

const TOON = "1-S2-1-267727";

// ---- fake File System Access handles (mocks) ----
function fakeFile(name: string, size = 16, lastModified = 1000): FileHandleLike {
  return {
    kind: "file",
    name,
    getFile: async () => new File([new Uint8Array(size)], name, { lastModified }),
  };
}

interface FakeDir extends DirectoryHandleLike {
  opened: () => number;
}

function fakeDir(name: string, children: Array<FileHandleLike | DirectoryHandleLike>): FakeDir {
  let opened = 0;
  return {
    kind: "directory",
    name,
    opened: () => opened,
    async *values() {
      opened += 1;
      for (const child of children) yield child;
    },
  };
}

function brokenDir(name: string): DirectoryHandleLike {
  return {
    kind: "directory",
    name,
    values: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new DOMException("gone", "NotFoundError")),
      }),
    }),
  };
}

function accountsTree() {
  const maps = fakeDir("Maps", [fakeFile("custom.SC2Map")]);
  const multiplayer = fakeDir("Multiplayer", [
    fakeFile("Tourmaline LE.SC2Replay", 32, 5000),
    fakeFile("notes.txt"),
    fakeFile("Winter Madness LE.sc2replay", 8, 6000),
  ]);
  const toon = fakeDir(TOON, [
    fakeDir("Replays", [multiplayer, fakeDir("VersusAI", [fakeFile("ai.SC2Replay")])]),
    fakeDir("Hotkeys", [fakeFile("keys.SC2Hotkeys")]),
  ]);
  const account = fakeDir("12345", [toon, brokenDir("Broken")]);
  const root = fakeDir("StarCraft II", [fakeDir("Accounts", [account]), maps]);
  return { root, maps, multiplayer, toon };
}

describe("walkMultiplayerReplays", () => {
  it("finds only Multiplayer replays and keeps the toon folder in the path", async () => {
    const { root, maps } = accountsTree();
    const found = await walkMultiplayerReplays(root, { yieldToEventLoop: async () => {} });
    expect(found.map((f) => f.relativePath)).toEqual([
      `StarCraft II/Accounts/12345/${TOON}/Replays/Multiplayer/Tourmaline LE.SC2Replay`,
      `StarCraft II/Accounts/12345/${TOON}/Replays/Multiplayer/Winter Madness LE.sc2replay`,
    ]);
    expect(found.map((f) => toonFromPath(f.relativePath))).toEqual([TOON, TOON]);
    expect(found[0]).toMatchObject({ name: "Tourmaline LE.SC2Replay", size: 32, lastModified: 5000 });
    expect((await found[1].getFile()).size).toBe(8);
    // Known StarCraft II folders are pruned (Maps is never listed).
    expect(maps.opened()).toBe(0);
  });

  it("accepts a toon folder or the Multiplayer folder as the picked root", async () => {
    const { toon, multiplayer } = accountsTree();
    const fromToon = await walkMultiplayerReplays(toon, { yieldToEventLoop: async () => {} });
    expect(fromToon[0].relativePath).toBe(`${TOON}/Replays/Multiplayer/Tourmaline LE.SC2Replay`);
    const fromMultiplayer = await walkMultiplayerReplays(multiplayer, { yieldToEventLoop: async () => {} });
    expect(fromMultiplayer.map((f) => f.relativePath)).toEqual([
      "Multiplayer/Tourmaline LE.SC2Replay",
      "Multiplayer/Winter Madness LE.sc2replay",
    ]);
  });
});

describe("walkMultiplayerReplays: responsiveness", () => {
  it("yields to the event loop regularly and reports progress", async () => {
    const files = Array.from({ length: 100 }, (_, i) => fakeFile(`g${i}.SC2Replay`));
    const root = fakeDir("Multiplayer", files);
    const yieldSpy = vi.fn(async () => {});
    const onEntry = vi.fn();
    const found = await walkMultiplayerReplays(root, { yieldToEventLoop: yieldSpy, onEntry });
    expect(found).toHaveLength(100);
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(100 / YIELD_EVERY_ENTRIES));
    expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({ scanned: expect.any(Number) }));
  });

  it("also yields on a time budget even with few entries", async () => {
    let clock = 0;
    const root = fakeDir("Multiplayer", [fakeFile("a.SC2Replay"), fakeFile("b.SC2Replay")]);
    const yieldSpy = vi.fn(async () => {});
    await walkMultiplayerReplays(root, {
      yieldToEventLoop: yieldSpy,
      now: () => {
        clock += 20;
        return clock;
      },
    });
    expect(yieldSpy).toHaveBeenCalledTimes(2);
  });

  it("works with the default setTimeout yield", async () => {
    const found = await walkMultiplayerReplays(accountsTree().root);
    expect(found).toHaveLength(2);
  });

  it("stops with an AbortError when cancelled", async () => {
    const controller = new AbortController();
    const root = fakeDir("Multiplayer", Array.from({ length: 50 }, (_, i) => fakeFile(`g${i}.SC2Replay`)));
    const walk = walkMultiplayerReplays(root, {
      signal: controller.signal,
      yieldToEventLoop: async () => controller.abort(),
    });
    await expect(walk).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("permissions", () => {
  const withPermission = (state: PermissionState | Error): DirectoryHandleLike => ({
    kind: "directory",
    name: "Accounts",
    async *values() {},
    queryPermission: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
    requestPermission: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
  });

  it("maps permission states", async () => {
    expect(await queryReadPermission(withPermission("granted"))).toBe("granted");
    expect(await queryReadPermission(withPermission("prompt"))).toBe("prompt");
    expect(await queryReadPermission(withPermission("denied"))).toBe("denied");
    expect(await requestReadPermission(withPermission("granted"))).toBe("granted");
    expect(await requestReadPermission(withPermission("denied"))).toBe("denied");
  });

  it("treats errors as prompt and a missing API as granted", async () => {
    const failing = withPermission(new DOMException("no gesture", "SecurityError"));
    expect(await queryReadPermission(failing)).toBe("prompt");
    expect(await requestReadPermission(failing)).toBe("prompt");
    const plain = fakeDir("Accounts", []);
    expect(await queryReadPermission(plain)).toBe("granted");
    expect(await requestReadPermission(plain)).toBe("granted");
  });
});

describe("shouldAutoScan", () => {
  const now = 10_000_000;
  it("debounces automatic scans to 10 minutes", () => {
    expect(shouldAutoScan(null, now)).toBe(true);
    expect(shouldAutoScan(now - MIN_AUTO_SCAN_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldAutoScan(now - MIN_AUTO_SCAN_INTERVAL_MS, now)).toBe(true);
    expect(MIN_AUTO_SCAN_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it("scans when the stored time is in the future (clock moved)", () => {
    expect(shouldAutoScan(now + 1000, now)).toBe(true);
  });
});

describe("pickReplaysFolder", () => {
  it("opens a read-only picker with a stable id", async () => {
    const handle = fakeDir("Accounts", []);
    const showDirectoryPicker = vi.fn(async () => handle);
    const host = { showDirectoryPicker };
    expect(supportsDirectoryPicker(host)).toBe(true);
    expect(await pickReplaysFolder(host)).toBe(handle);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ id: DIRECTORY_PICKER_ID, mode: "read" });
  });

  it("returns null when cancelled or unsupported, rethrows other errors", async () => {
    const cancel = { showDirectoryPicker: async () => Promise.reject(new DOMException("x", "AbortError")) };
    expect(await pickReplaysFolder(cancel)).toBeNull();
    expect(supportsDirectoryPicker({})).toBe(false);
    expect(await pickReplaysFolder({})).toBeNull();
    const broken = { showDirectoryPicker: async () => Promise.reject(new DOMException("x", "SecurityError")) };
    await expect(pickReplaysFolder(broken)).rejects.toMatchObject({ name: "SecurityError" });
    expect(await pickReplaysFolder({ showDirectoryPicker: async () => ({ kind: "file" }) })).toBeNull();
  });

  it("recognises directory handles", () => {
    expect(isDirectoryHandle(fakeDir("x", []))).toBe(true);
    expect(isDirectoryHandle({ kind: "directory", name: "x" })).toBe(false);
    expect(isDirectoryHandle(null)).toBe(false);
  });
});

describe("filesFromDirectoryInput", () => {
  function withPath(name: string, path: string): File {
    const file = new File(["abcd"], name, { lastModified: 77 });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  }

  it("keeps Multiplayer replays with their relative paths", async () => {
    const files = [
      withPath("a.SC2Replay", `Accounts/1/${TOON}/Replays/Multiplayer/a.SC2Replay`),
      withPath("b.SC2Replay", `Accounts/1/${TOON}/Replays/VersusAI/b.SC2Replay`),
      withPath("c.txt", `Accounts/1/${TOON}/Replays/Multiplayer/c.txt`),
    ];
    const out = filesFromDirectoryInput(files);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "a.SC2Replay",
      relativePath: `Accounts/1/${TOON}/Replays/Multiplayer/a.SC2Replay`,
      size: 4,
      lastModified: 77,
    });
    expect(await out[0].getFile()).toBe(files[0]);
  });
});
