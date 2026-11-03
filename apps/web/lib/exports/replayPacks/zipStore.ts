import { PACK_NAME_BYTES, validReplayFilename, foldPackName } from "./packNames";
import { MANIFEST_BYTES, README_BYTES } from "./packMetadata";

export const ZIP_CHUNK_BYTES = 64 * 1024;
export const REPLAY_BYTES = 5 * 1024 * 1024;
export const ZIP_ENTRY_LIMIT = 102;
const MAX_UINT32 = 0xfffffffe;
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export type ZipEntryKind = "replay" | "manifest" | "readme";
type Entry = { name: Uint8Array; crc: number; size: number; offset: number };

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) throw new Error("invalid_zip_size");
  return value;
}

function header(entry: Entry, central: boolean): Uint8Array {
  const length = central ? 46 : 30, output = new Uint8Array(length + entry.name.byteLength), view = new DataView(output.buffer);
  view.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
  let at = 4;
  if (central) { view.setUint16(at, 20, true); at += 2; }
  view.setUint16(at, 20, true); view.setUint16(at + 2, 0x0800, true); view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true); view.setUint16(at + 8, 0x0021, true);
  view.setUint32(at + 10, entry.crc, true); view.setUint32(at + 14, uint32(entry.size), true); view.setUint32(at + 18, uint32(entry.size), true);
  view.setUint16(at + 22, entry.name.byteLength, true);
  if (central) view.setUint32(42, uint32(entry.offset), true);
  output.set(entry.name, length);
  return output;
}

/** Store-only ZIP32: one bounded input file, a tiny central directory and one awaited output chunk at a time. */
export class StoreZip {
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private invalid = false;
  private busy = false;
  private completed = false;
  private replayCount = 0;
  constructor(private readonly output: (chunk: Uint8Array) => Promise<void>) {}

  abort() { this.invalid = true; }
  private check() { if (this.invalid || this.busy || this.completed) throw new Error("invalid_zip_state"); }

  async add(name: string, bytes: Uint8Array, kind: ZipEntryKind): Promise<void> {
    this.check();
    const cap = kind === "replay" ? REPLAY_BYTES : kind === "manifest" ? MANIFEST_BYTES : README_BYTES;
    const validName = kind === "replay" ? validReplayFilename(name) : name === (kind === "manifest" ? "manifest.csv" : "README.txt");
    if (!validName || typeof name !== "string" || name.length > PACK_NAME_BYTES || !(bytes instanceof Uint8Array)) throw new Error("invalid_zip_entry");
    const encodedName = encoder.encode(name), folded = foldPackName(name);
    if (!validName || encodedName.byteLength > PACK_NAME_BYTES || this.entries.length >= ZIP_ENTRY_LIMIT || this.names.has(folded)
      || !["replay", "manifest", "readme"].includes(kind) || bytes.byteLength > cap || (kind === "replay" && bytes.byteLength < 4)) throw new Error("invalid_zip_entry");
    if (kind === "replay" && this.replayCount >= 100) throw new Error("invalid_zip_entry");
    const entry = { name: encodedName, crc: crc32(bytes), size: bytes.byteLength, offset: this.offset };
    uint32(this.offset + 30 + encodedName.byteLength + bytes.byteLength);
    this.busy = true;
    try {
      await this.emit(header(entry, false));
      for (let offset = 0; offset < bytes.byteLength; offset += ZIP_CHUNK_BYTES) await this.emit(bytes.slice(offset, offset + ZIP_CHUNK_BYTES));
      this.entries.push(entry); this.names.add(folded); if (kind === "replay") this.replayCount += 1;
    } catch (error) { this.invalid = true; throw error; }
    finally { this.busy = false; }
  }

  async finish(): Promise<void> {
    if (!this.names.has("manifest.csv") || !this.names.has("readme.txt")) throw new Error("invalid_zip_metadata");
    this.check(); this.busy = true;
    try {
      const start = this.offset;
      for (const entry of this.entries) await this.emit(header(entry, true));
      const size = uint32(this.offset - start), end = new Uint8Array(22), view = new DataView(end.buffer);
      uint32(this.offset + end.byteLength);
      view.setUint32(0, 0x06054b50, true); view.setUint16(8, this.entries.length, true); view.setUint16(10, this.entries.length, true);
      view.setUint32(12, size, true); view.setUint32(16, uint32(start), true);
      await this.emit(end); this.completed = true;
    } catch (error) { this.invalid = true; throw error; }
    finally { this.busy = false; }
  }

  private async emit(chunk: Uint8Array) {
    if (this.invalid) throw new Error("invalid_zip_state");
    const length = chunk.byteLength;
    uint32(this.offset + length);
    await this.output(chunk);
    if (this.invalid) throw new Error("invalid_zip_state");
    this.offset += length;
  }
}
