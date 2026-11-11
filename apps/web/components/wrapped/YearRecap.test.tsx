import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { ReplayHeaderResult } from "@/lib/instant/types";
import { YearRecap } from "./YearRecap";

const engine = vi.hoisted(() => ({
  scanHeaders: vi.fn<() => Promise<ReplayHeaderResult[]>>(),
  dispose: vi.fn(),
  factory: vi.fn(),
}));
vi.mock("@/lib/instant/engineClient", () => ({ createEngineClient: engine.factory }));

beforeEach(() => {
  engine.scanHeaders.mockReset();
  engine.dispose.mockReset();
  engine.factory.mockReset().mockReturnValue(engine);
});
afterEach(cleanup);
afterEach(vi.unstubAllGlobals);

async function pickReplay() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Replay files"), {
      target: { files: [new File(["replay"], "private.SC2Replay", { lastModified: Date.UTC(2026, 1, 1) })] },
    });
    await vi.dynamicImportSettled();
  });
}

it("cancels an in-flight scan without committing stale results", async () => {
  let complete: (rows: ReplayHeaderResult[]) => void = () => undefined;
  engine.scanHeaders.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  render(<ToastProvider><YearRecap /></ToastProvider>);
  await pickReplay();
  expect(engine.factory).toHaveBeenCalledWith({ refreshPolicy: false });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => complete([{ ok: false, errorKind: "parse_failed" }]));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose your replays" }));
  expect(screen.queryByText("Couldn’t read the replays")).toBeNull();
  expect(engine.dispose).toHaveBeenCalledOnce();
});

it("stops a dropped directory while its browser read is pending", async () => {
  let list: (entries: FileSystemEntry[]) => void = () => undefined;
  const readEntries = vi.fn((resolve: typeof list) => { list = resolve; });
  const root = { isDirectory: true, createReader: () => ({ readEntries }) };
  const file = vi.fn();
  render(<ToastProvider><YearRecap /></ToastProvider>);
  await act(async () => fireEvent.drop(screen.getByRole("region", { name: "Choose your replays" }), {
    dataTransfer: { items: [{ webkitGetAsEntry: () => root }] },
  }));
  expect(readEntries).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => list([{ isFile: true, file } as unknown as FileSystemFileEntry]));
  expect(readEntries).toHaveBeenCalledOnce();
  expect(file).not.toHaveBeenCalled();
  expect(engine.factory).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Choose your replays" })).toBeTruthy();
});

it("scans replays at the root of a natively picked export folder", async () => {
  const replay = new File(["replay"], "private.SC2Replay", { lastModified: Date.UTC(2026, 1, 1) });
  const picker = vi.fn(async () => ({
    kind: "directory",
    name: "Export",
    async *values() {
      yield { kind: "file", name: replay.name, getFile: async () => replay };
    },
  }));
  vi.stubGlobal("showDirectoryPicker", picker);
  engine.scanHeaders.mockResolvedValueOnce([{ ok: false, errorKind: "corrupt_file" }]);
  render(<ToastProvider><YearRecap /></ToastProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    await vi.dynamicImportSettled();
  });
  expect(picker).toHaveBeenCalledWith({ id: "sc2-accounts", mode: "read" });
  expect(engine.scanHeaders).toHaveBeenCalledWith([expect.objectContaining({
    name: "private.SC2Replay", relativePath: "Export/private.SC2Replay",
  })], expect.anything());
});

it("offers a retry after an engine failure and reuses the same local source", async () => {
  engine.scanHeaders.mockRejectedValueOnce(new Error("could not boot"))
    .mockResolvedValueOnce([{ ok: false, errorKind: "corrupt_file" }]);
  render(<ToastProvider><YearRecap /></ToastProvider>);
  await pickReplay();
  expect(screen.getByRole("heading", { name: "Couldn’t read the replays" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(engine.scanHeaders).toHaveBeenCalledTimes(2);
  expect(engine.dispose).toHaveBeenCalledTimes(2);
});
