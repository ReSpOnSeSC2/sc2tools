import { describe, expect, it } from "vitest";
import { GIF_PALETTE, GifWriter, quantize } from "@/lib/clip/gifEncoder";
import { createGifWorkerProtocol, type GifWorkerOutput } from "@/lib/clip/gifWorkerProtocol";

/** A minimal GIF reader for the test: frames, delays and LZW-decoded indices. */
function readGif(bytes: Uint8Array) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const header = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16(), height = u16(), packed = u8();
  p += 2;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  const frames: { delay: number; indices: number[] }[] = [];
  let delay = 0;
  let loops = false;
  for (;;) {
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      const subBlocks: number[] = [];
      for (let size = u8(); size; size = u8()) { subBlocks.push(...bytes.slice(p, p + size)); p += size; }
      if (label === 0xf9) delay = subBlocks[1] | (subBlocks[2] << 8);
      if (label === 0xff && String.fromCharCode(...subBlocks.slice(0, 11)) === "NETSCAPE2.0") loops = true;
      continue;
    }
    if (block !== 0x2c) throw new Error(`unexpected block ${block}`);
    p += 8; // left, top, width, height
    u8(); // packed
    const minCode = u8();
    const data: number[] = [];
    for (let size = u8(); size; size = u8()) { data.push(...bytes.slice(p, p + size)); p += size; }
    frames.push({ delay, indices: lzwDecode(data, minCode, width * height) });
  }
  return { header, width, height, frames, loops };
}

function lzwDecode(data: number[], minCode: number, pixels: number): number[] {
  const clear = 1 << minCode, end = clear + 1;
  let width = minCode + 1, next = end + 1;
  let table: number[][] = [];
  const reset = () => { table = Array.from({ length: clear }, (_, i) => [i]); table[clear] = []; table[end] = []; width = minCode + 1; next = end + 1; };
  reset();
  const out: number[] = [];
  let bit = 0, prev: number[] | null = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < width; i += 1, bit += 1) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return code;
  };
  while (out.length < pixels) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === end) break;
    let entry: number[];
    if (code < next && table[code]) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("bad code");
    out.push(...entry);
    if (prev && next < 4096) { table[next++] = [...prev, entry[0]]; if (next === 1 << width && width < 12) width += 1; }
    prev = entry;
  }
  return out;
}

function noise(width: number, height: number, seed: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let i = 0; i < rgba.length; i += 4) {
    s = (s * 1103515245 + 12345) >>> 0;
    rgba[i] = s & 0xff; rgba[i + 1] = (s >> 8) & 0xff; rgba[i + 2] = (s >> 16) & 0xff; rgba[i + 3] = 255;
  }
  return rgba;
}

describe("GifWriter", () => {
  it("writes a looping GIF89a whose frames decode back to the quantised pixels", () => {
    const gif = new GifWriter(37, 23, 12);
    const frames = [noise(37, 23, 1), noise(37, 23, 2), new Uint8ClampedArray(37 * 23 * 4).fill(255)];
    frames.forEach((frame) => gif.addFrame(frame));
    expect(gif.frameCount).toBe(3);
    const parsed = readGif(gif.finish());
    expect(parsed.header).toBe("GIF89a");
    expect([parsed.width, parsed.height]).toEqual([37, 23]);
    expect(parsed.loops).toBe(true);
    expect(parsed.frames).toHaveLength(3);
    frames.forEach((frame, i) => {
      expect(parsed.frames[i].indices).toEqual([...quantize(frame, new Uint8Array(37 * 23))]);
    });
    // 12 fps in whole centiseconds without drift: 8, 9, 8 …
    expect(parsed.frames.map((f) => f.delay)).toEqual([8, 9, 8]);
  });

  it("survives a full LZW table (code-size growth and clear codes)", () => {
    const gif = new GifWriter(256, 64, 10);
    const frame = noise(256, 64, 99);
    gif.addFrame(frame);
    const parsed = readGif(gif.finish());
    expect(parsed.frames[0].indices).toEqual([...quantize(frame, new Uint8Array(256 * 64))]);
  });

  it("maps colours onto the 6×7×6 cube", () => {
    const out = quantize([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255], new Uint8Array(3));
    expect([...GIF_PALETTE.slice(out[0] * 3, out[0] * 3 + 3)]).toEqual([255, 255, 255]);
    expect(out[1]).toBe(0);
    expect([...GIF_PALETTE.slice(out[2] * 3, out[2] * 3 + 3)]).toEqual([255, 0, 0]);
    expect(() => new GifWriter(0, 10, 12)).toThrow(RangeError);
  });
});

describe("GIF worker protocol", () => {
  function run(messages: unknown[]) {
    const out: GifWorkerOutput[] = [];
    const protocol = createGifWorkerProtocol((message) => out.push(message));
    for (const message of messages) protocol.receive(message);
    return out;
  }
  const frame = (index: number) => ({ type: "frame", index, rgba: noise(4, 4, index + 1).buffer });

  it("acknowledges every frame in order and returns the finished GIF", () => {
    const out = run([{ type: "start", width: 4, height: 4, fps: 12, maxBytes: 1e6 }, frame(0), frame(1), { type: "finish" }]);
    expect(out.map((m) => m.type)).toEqual(["frame-done", "frame-done", "done"]);
    const done = out[2] as Extract<GifWorkerOutput, { type: "done" }>;
    expect(readGif(new Uint8Array(done.gif)).frames).toHaveLength(2);
  });

  it("stops on the size cap and rejects out-of-order frames", () => {
    expect(run([{ type: "start", width: 4, height: 4, fps: 12, maxBytes: 10 }, frame(0), frame(1)]))
      .toEqual([{ type: "error", reason: "too_large" }]);
    expect(run([{ type: "start", width: 4, height: 4, fps: 12, maxBytes: 1e6 }, frame(1)]))
      .toEqual([{ type: "error", reason: "bad_message" }]);
  });
});
