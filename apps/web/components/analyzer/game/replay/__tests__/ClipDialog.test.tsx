import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MapPlayback } from "@/lib/mapReplay";
import ClipDialog from "../clip/ClipDialog";

const recordVideo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({}) }));
vi.mock("@/lib/map-images", () => ({ getMapLayoutUrl: () => null }));
vi.mock("../clip/clipRender", () => ({ clipCamera: vi.fn(), renderClipFrame: vi.fn() }));
vi.mock("../clip/clipRecorder", () => ({
  canRecordVideo: () => true,
  recordVideoClip: recordVideo,
  recordGifClip: vi.fn(),
  ClipError: class extends Error {},
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("announces clip milestones while keeping precise frame progress available", async () => {
  let progress!: (done: number, total: number) => void;
  let finish!: (blob: Blob) => void;
  recordVideo.mockImplementation(({ onProgress }) => {
    progress = onProgress;
    return new Promise<Blob>(resolve => { finish = resolve; });
  });
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => "blob:clip", revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({} as CanvasRenderingContext2D));
  const playback = { stats: { me: [], opp: [] }, mapName: "Alcyone LE", gameLength: 600 } as unknown as MapPlayback;
  render(<ClipDialog open onClose={vi.fn()} playback={playback} time={90} vision="both" races={{}}
    owner={false} replayer={{ current: null }} onStart={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Make clip" }));
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Preparing the map.");
  const bar = await screen.findByRole("progressbar", { name: "Clip progress" });
  expect(status.textContent).toBe("Recording clip.");
  act(() => progress(10, 100));
  expect(status.textContent).toBe("Recording clip: 10 percent.");
  act(() => progress(11, 100));
  expect(status.textContent).toBe("Recording clip: 10 percent.");
  expect(bar.getAttribute("aria-valuenow")).toBe("11");
  await act(async () => finish(new Blob(["clip"])));
  expect(status.textContent).toBe("Clip ready to download.");
  expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toBe("blob:clip");
});
