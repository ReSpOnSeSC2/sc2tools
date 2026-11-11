import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipFrameCount, clipFrameTime, GIF_FPS, VIDEO_FPS } from "@/lib/clip/clipPlan";
import type { MapPlayback } from "@/lib/mapReplay";
import ClipDialog from "../clip/ClipDialog";
import type { recordGifClip, recordVideoClip } from "../clip/clipRecorder";
import type { renderClipFrame } from "../clip/clipRender";
import { createClipSurface } from "../clip/clipSurface";

const mocks = vi.hoisted(() => ({
  recordVideo: vi.fn<typeof recordVideoClip>(), recordGif: vi.fn<typeof recordGifClip>(),
  renderFrame: vi.fn<typeof renderClipFrame>(), mapUrl: null as string | null,
}));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({}) }));
vi.mock("@/lib/map-images", () => ({ getMapLayoutUrl: () => mocks.mapUrl }));
vi.mock("../clip/clipRender", () => ({ clipCamera: vi.fn(), renderClipFrame: mocks.renderFrame }));
vi.mock("../clip/clipRecorder", async (importOriginal) => ({
  ...await importOriginal<typeof import("../clip/clipRecorder")>(), canRecordVideo: () => true,
  recordVideoClip: mocks.recordVideo, recordGifClip: mocks.recordGif,
}));

const dimensions = { width: 1280, height: 720 };
const range = { start: 90, end: 92 };
const copy = vi.fn();
const pixels = new Uint8ClampedArray([30, 60, 90, 255]);
const getImageData = vi.fn(() => ({ data: pixels }));
const context2d = { getImageData };
class Offscreen {
  constructor(public width: number, public height: number) {}
  getContext() { return context2d; }
}

const playback = { stats: { me: [], opp: [] }, mapName: "Alcyone LE", gameLength: 600 } as unknown as MapPlayback;
const open = () => render(<ClipDialog open onClose={vi.fn()} playback={playback} time={90} vision="both" races={{}}
  owner={false} replayer={{ current: null }} onStart={vi.fn()} />);

function recordTwoSeconds() {
  fireEvent.change(screen.getByLabelText("Start (m:ss)"), { target: { value: "1:30" } });
  fireEvent.change(screen.getByLabelText("End (m:ss)"), { target: { value: "1:32" } });
  fireEvent.click(screen.getByRole("button", { name: "Make clip" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.clearAllMocks();
  mocks.mapUrl = null;
  vi.stubGlobal("OffscreenCanvas", Offscreen);
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => "blob:clip", revokeObjectURL: vi.fn() }));
  copy.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: copy, getImageData } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("renders every video frame offscreen before it reaches the HTML capture canvas", async () => {
  const capture = { current: null as HTMLCanvasElement | null };
  mocks.recordVideo.mockImplementation(async ({ count, canvas, render }) => {
    capture.current = canvas;
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.isConnected).toBe(true);
    expect(canvas).toMatchObject(dimensions);
    expect(count).toBe(clipFrameCount(range, 1, VIDEO_FPS));
    copy.mockClear();
    mocks.renderFrame.mockClear();
    for (let index = 0; index < count; index++) {
      render(index);
      const [ctx, surface, time] = mocks.renderFrame.mock.calls[index];
      expect(ctx).toBe(context2d);
      expect(surface).toBeInstanceOf(Offscreen);
      expect(time).toBe(clipFrameTime(range, 1, VIDEO_FPS, index));
      expect(copy).toHaveBeenNthCalledWith(index + 1, surface, 0, 0);
      expect(mocks.renderFrame.mock.invocationCallOrder[index]).toBeLessThan(copy.mock.invocationCallOrder[index]);
    }
    return new Blob(["clip"], { type: "video/webm" });
  });
  open(); recordTwoSeconds();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toBe("blob:clip");
  expect(capture.current?.isConnected).toBe(false);
  expect(capture.current?.width).toBe(0);
});

it("reads each GIF frame from OffscreenCanvas without attaching an HTML canvas", async () => {
  mocks.recordGif.mockImplementation(async ({ count, frame }) => {
    expect(document.querySelector("canvas")).toBeNull();
    expect(count).toBe(clipFrameCount(range, 1, GIF_FPS));
    mocks.renderFrame.mockClear();
    for (let index = 0; index < count; index++) {
      expect(frame(index)).toBe(pixels.buffer);
      expect(mocks.renderFrame.mock.calls[index].slice(0, 3)).toEqual([context2d, expect.any(Offscreen), clipFrameTime(range, 1, GIF_FPS, index)]);
    }
    return new Blob(["clip"], { type: "image/gif" });
  });
  open(); fireEvent.click(screen.getByRole("radio", { name: /GIF/i })); recordTwoSeconds();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByRole("link", { name: /Download/ })).toBeTruthy();
  expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
});

it.each(["missing", "unsupported context", "copy failure"])("uses the HTML capture surface directly on %s", (failure) => {
  if (failure === "missing") vi.stubGlobal("OffscreenCanvas", undefined);
  if (failure === "unsupported context") vi.stubGlobal("OffscreenCanvas", class { getContext() { return null; } });
  if (failure === "copy failure") copy.mockImplementationOnce(() => { throw new Error("cannot copy"); });
  const surface = createClipSurface(1280, 720, "video");
  expect(surface.canvas).toBe(surface.captureCanvas);
  expect(surface.captureCanvas?.isConnected).toBe(true);
  expect(surface.ctx).toBe(HTMLCanvasElement.prototype.getContext("2d"));
  copy.mockClear();
  surface.present();
  expect(copy).not.toHaveBeenCalled();
  surface.dispose();
  expect(surface.captureCanvas?.isConnected).toBe(false);
});

it("uses a detached HTML drawing surface for GIF when OffscreenCanvas is missing", () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const surface = createClipSurface(640, 360, "gif");
  expect(surface.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(surface.captureCanvas).toBeNull();
  expect(document.querySelector("canvas")).toBeNull();
  expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
  surface.dispose();
});

it("cancels a pending map load, releases the capture surface and renders no frames", async () => {
  const image = document.createElement("img");
  const removeSrc = vi.spyOn(image, "removeAttribute");
  vi.stubGlobal("Image", class { constructor() { return image; } });
  mocks.mapUrl = "/known-map.png";
  open(); recordTwoSeconds();
  const capture = document.querySelector("canvas");
  expect(capture).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel clip" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Clip cancelled.");
  expect(capture?.isConnected).toBe(false);
  expect(removeSrc).toHaveBeenCalledWith("src");
  expect(mocks.renderFrame).not.toHaveBeenCalled();
  expect(mocks.recordVideo).not.toHaveBeenCalled();
});
