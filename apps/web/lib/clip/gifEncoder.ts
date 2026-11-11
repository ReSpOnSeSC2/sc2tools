/**
 * gifEncoder — a small, dependency-free animated GIF89a writer for
 * replay clips, run inside a worker (``gifWorker.ts``).
 *
 * The approach is the one gifenc and every classic encoder take, sized
 * for a fallback path rather than for photographic quality:
 *
 *   palette  one fixed global table, a 6×7×6 RGB cube (252 colours; the
 *            eye is most sensitive to green, so it gets the extra
 *            level). Quantising a pixel is three table lookups, so a
 *            frame never needs a palette pass of its own.
 *   LZW      the standard variable-width GIF LZW (12-bit codes, clear
 *            on a full table) with an open-addressed hash, the
 *            compress(1)/gifencoder layout — allocation-free per pixel.
 *   timing   per-frame delays in centiseconds that accumulate exactly,
 *            so 12 fps alternates 8 and 9 cs instead of drifting.
 *
 * Example:
 *   const gif = new GifWriter(640, 360, 12);
 *   gif.addFrame(rgba);            // Uint8ClampedArray from getImageData
 *   const bytes = gif.finish();    // Uint8Array starting "GIF89a"
 */

const R_LEVELS = 6;
const G_LEVELS = 7;
const B_LEVELS = 6;

/** 256 RGB triplets: the 252-colour cube, then black padding. */
export const GIF_PALETTE: Uint8Array = (() => {
  const palette = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < R_LEVELS; r += 1) {
    for (let g = 0; g < G_LEVELS; g += 1) {
      for (let b = 0; b < B_LEVELS; b += 1) {
        palette[i++] = Math.round((r * 255) / (R_LEVELS - 1));
        palette[i++] = Math.round((g * 255) / (G_LEVELS - 1));
        palette[i++] = Math.round((b * 255) / (B_LEVELS - 1));
      }
    }
  }
  return palette;
})();

const level = (levels: number, stride: number) =>
  Uint8Array.from({ length: 256 }, (_, v) => Math.round((v * (levels - 1)) / 255) * stride);
const R_INDEX = level(R_LEVELS, G_LEVELS * B_LEVELS);
const G_INDEX = level(G_LEVELS, B_LEVELS);
const B_INDEX = level(B_LEVELS, 1);

/** RGBA → palette indices, one per pixel. Alpha is ignored (frames are opaque). */
export function quantize(rgba: ArrayLike<number>, out: Uint8Array): Uint8Array {
  const n = Math.min(out.length, Math.floor(rgba.length / 4));
  for (let p = 0, i = 0; p < n; p += 1, i += 4) out[p] = R_INDEX[rgba[i]] + G_INDEX[rgba[i + 1]] + B_INDEX[rgba[i + 2]];
  return out;
}

/** Growable byte buffer. */
class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  length = 0;
  private reserve(extra: number) {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
  byte(value: number) {
    this.reserve(1);
    this.buffer[this.length++] = value & 0xff;
  }
  word(value: number) {
    this.byte(value);
    this.byte(value >> 8);
  }
  bytes(values: ArrayLike<number>, count = values.length) {
    this.reserve(count);
    for (let i = 0; i < count; i += 1) this.buffer[this.length++] = values[i];
  }
  ascii(text: string) {
    for (let i = 0; i < text.length; i += 1) this.byte(text.charCodeAt(i));
  }
  take(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

const BITS = 12;
const MAX_CODES = 1 << BITS;
const HASH_SIZE = 5003;

/** Pooled LZW state: one encoder serves every frame of a clip. */
class LzwEncoder {
  private readonly hashes = new Int32Array(HASH_SIZE);
  private readonly codes = new Int32Array(HASH_SIZE);
  private readonly block = new Uint8Array(255);
  private blockLength = 0;
  private accumulator = 0;
  private accumulatedBits = 0;
  private width = 0;
  private maxCode = 0;
  private nextCode = 0;
  private clearPending = false;
  private sink!: ByteSink;

  encode(pixels: Uint8Array, minCodeSize: number, sink: ByteSink): void {
    this.sink = sink;
    sink.byte(minCodeSize);
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    const initialWidth = minCodeSize + 1;
    this.width = initialWidth;
    this.maxCode = (1 << this.width) - 1;
    this.nextCode = clear + 2;
    this.clearPending = false;
    this.accumulator = 0;
    this.accumulatedBits = 0;
    this.blockLength = 0;
    let shift = 0;
    for (let probe = HASH_SIZE; probe < 65536; probe *= 2) shift += 1;
    shift = 8 - shift;
    this.hashes.fill(-1);
    this.output(clear, initialWidth, end);
    let prefix = pixels[0];
    outer: for (let p = 1; p < pixels.length; p += 1) {
      const c = pixels[p];
      const key = (c << BITS) + prefix;
      let slot = (c << shift) ^ prefix;
      if (this.hashes[slot] === key) { prefix = this.codes[slot]; continue; }
      if (this.hashes[slot] >= 0) {
        const step = slot === 0 ? 1 : HASH_SIZE - slot;
        do {
          slot -= step;
          if (slot < 0) slot += HASH_SIZE;
          if (this.hashes[slot] === key) { prefix = this.codes[slot]; continue outer; }
        } while (this.hashes[slot] >= 0);
      }
      this.output(prefix, initialWidth, end);
      prefix = c;
      if (this.nextCode < MAX_CODES) {
        this.codes[slot] = this.nextCode++;
        this.hashes[slot] = key;
      } else {
        this.hashes.fill(-1);
        this.nextCode = clear + 2;
        this.clearPending = true;
        this.output(clear, initialWidth, end);
      }
    }
    this.output(prefix, initialWidth, end);
    this.output(end, initialWidth, end);
    sink.byte(0); // block terminator
  }

  private output(code: number, initialWidth: number, end: number) {
    this.accumulator = this.accumulatedBits > 0 ? this.accumulator | (code << this.accumulatedBits) : code;
    this.accumulatedBits += this.width;
    while (this.accumulatedBits >= 8) {
      this.push(this.accumulator & 0xff);
      this.accumulator >>= 8;
      this.accumulatedBits -= 8;
    }
    if (this.nextCode > this.maxCode || this.clearPending) {
      if (this.clearPending) {
        this.width = initialWidth;
        this.maxCode = (1 << this.width) - 1;
        this.clearPending = false;
      } else {
        this.width += 1;
        this.maxCode = this.width === BITS ? MAX_CODES : (1 << this.width) - 1;
      }
    }
    if (code === end) {
      while (this.accumulatedBits > 0) {
        this.push(this.accumulator & 0xff);
        this.accumulator >>= 8;
        this.accumulatedBits -= 8;
      }
      this.flush();
    }
  }

  private push(value: number) {
    this.block[this.blockLength++] = value;
    if (this.blockLength === 255) this.flush();
  }

  private flush() {
    if (this.blockLength === 0) return;
    this.sink.byte(this.blockLength);
    this.sink.bytes(this.block, this.blockLength);
    this.blockLength = 0;
  }
}

/** Streams frames into one looping GIF89a. */
export class GifWriter {
  private readonly sink = new ByteSink();
  private readonly lzw = new LzwEncoder();
  private readonly indices: Uint8Array;
  private frames = 0;
  private finished = false;

  constructor(readonly width: number, readonly height: number, readonly fps: number) {
    if (!(width > 0 && height > 0 && width <= 4096 && height <= 4096) || !(fps > 0 && fps <= 50)) {
      throw new RangeError("gif_size");
    }
    this.indices = new Uint8Array(width * height);
    const sink = this.sink;
    sink.ascii("GIF89a");
    sink.word(width);
    sink.word(height);
    sink.byte(0xf7); // global table, 8-bit colour resolution, 256 entries
    sink.byte(0); // background index
    sink.byte(0); // square pixels
    sink.bytes(GIF_PALETTE);
    // NETSCAPE2.0: loop forever.
    sink.byte(0x21); sink.byte(0xff); sink.byte(11); sink.ascii("NETSCAPE2.0");
    sink.byte(3); sink.byte(1); sink.word(0); sink.byte(0);
  }

  /** Bytes written so far, for the size cap. */
  get byteLength(): number { return this.sink.length; }
  get frameCount(): number { return this.frames; }

  /** Delay of frame ``index`` in centiseconds, accumulated without drift. */
  static delayCs(index: number, fps: number): number {
    return Math.round(((index + 1) * 100) / fps) - Math.round((index * 100) / fps);
  }

  addFrame(rgba: ArrayLike<number>): void {
    if (this.finished) throw new Error("gif_finished");
    if (rgba.length < this.width * this.height * 4) throw new RangeError("gif_frame_size");
    const sink = this.sink;
    // Graphic control extension: no disposal, no transparency, delay.
    sink.byte(0x21); sink.byte(0xf9); sink.byte(4); sink.byte(0);
    sink.word(GifWriter.delayCs(this.frames, this.fps));
    sink.byte(0); sink.byte(0);
    // Image descriptor: the full canvas, global palette.
    sink.byte(0x2c); sink.word(0); sink.word(0); sink.word(this.width); sink.word(this.height); sink.byte(0);
    this.lzw.encode(quantize(rgba, this.indices), 8, sink);
    this.frames += 1;
  }

  finish(): Uint8Array {
    if (!this.finished) {
      this.sink.byte(0x3b);
      this.finished = true;
    }
    return this.sink.take();
  }
}
