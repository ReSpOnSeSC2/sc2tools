// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { crc32, StoreZip, REPLAY_BYTES, ZIP_CHUNK_BYTES } from "./zipStore";
import { replayPackManifest, replayPackReadme } from "./packMetadata";

const encode = (text: string) => new TextEncoder().encode(text);
function concatenate(chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
const manifest = () => replayPackManifest([{ gameId: "one", filename: "one.SC2Replay", status: "saved" }]);
const readme = () => replayPackReadme({ requested: 1, saved: 1, failed: 0, cancelled: 0 });

describe("bounded store ZIP32", () => {
  it("matches the published CRC32 vector and emits the fixed little-endian UTF8 store header", async () => {
    expect(crc32(encode("123456789"))).toBe(0xcbf43926); expect(crc32(new Uint8Array())).toBe(0);
    const chunks: Uint8Array[] = [], zip = new StoreZip(async chunk => { chunks.push(chunk.slice()); });
    await zip.add("one.SC2Replay", encode("123456789"), "replay");
    expect(Buffer.from(chunks[0]).toString("hex")).toBe([
      "504b0304", "1400", "0008", "0000", "0000", "2100", "2639f4cb", "09000000", "09000000", "0d00", "0000",
      "6f6e652e5343325265706c6179",
    ].join(""));
    await expect(zip.finish()).rejects.toThrow("invalid_zip_metadata");
    await zip.add("manifest.csv", manifest(), "manifest"); await zip.add("README.txt", readme(), "readme"); await zip.finish();
    expect(chunks.every(chunk => chunk.byteLength <= ZIP_CHUNK_BYTES)).toBe(true);
  });

  it("Python zipfile independently reads actual archive bytes, CRCs, UTF8 names, central offsets and exact contents", async () => {
    const chunks: Uint8Array[] = [], zip = new StoreZip(async chunk => { chunks.push(chunk.slice()); });
    const selected = [{ gameId: "one", filename: "one.SC2Replay", status: "saved" as const }, { gameId: "two", filename: "\u6226.SC2Replay", status: "saved" as const }];
    const files = new Map([["one.SC2Replay", encode("123456789")], ["\u6226.SC2Replay", encode("second original")],
      ["manifest.csv", replayPackManifest(selected)], ["README.txt", replayPackReadme({ requested: 2, saved: 2, failed: 0, cancelled: 0 })]]);
    for (const [name, bytes] of files) await zip.add(name, bytes, name === "manifest.csv" ? "manifest" : name === "README.txt" ? "readme" : "replay");
    await zip.finish();
    const bytes = concatenate(chunks);
    const script = ["import base64,io,json,sys,zipfile", "z=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.read())))",
      "assert z.testzip() is None", "print(json.dumps([{'name':i.filename,'data':base64.b64encode(z.read(i)).decode(),'method':i.compress_type,'flags':i.flag_bits,'offset':i.header_offset,'date':list(i.date_time)} for i in z.infolist()]))"].join("\n");
    const actual = JSON.parse(execFileSync("python", ["-c", script], { input: Buffer.from(bytes).toString("base64"), encoding: "utf8", windowsHide: true }));
    expect(actual.map((row: { name: string }) => row.name)).toEqual([...files.keys()]);
    for (const row of actual) {
      expect(row.data).toBe(Buffer.from(files.get(row.name)!).toString("base64")); expect(row.method).toBe(0); expect(row.flags & 0x0800).toBe(0x0800);
      expect(row.date).toEqual([1980, 1, 1, 0, 0, 0]); expect(new DataView(bytes.buffer).getUint32(row.offset, true)).toBe(0x04034b50);
    }
    const end = new DataView(bytes.buffer, bytes.byteLength - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50); expect(end.getUint16(10, true)).toBe(4);
    expect(end.getUint32(16, true) + end.getUint32(12, true) + 22).toBe(bytes.byteLength);
  });

  it("awaits each output acknowledgment and accounts transferred/detached chunks by their original length", async () => {
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    const emitted: Uint8Array[] = [];
    const zip = new StoreZip(async chunk => {
      emitted.push(new Uint8Array(structuredClone(chunk.buffer, { transfer: [chunk.buffer as ArrayBuffer] })));
      if (emitted.length === 1) await held;
    });
    const work = zip.add("one.SC2Replay", new Uint8Array(ZIP_CHUNK_BYTES + 4), "replay");
    await Promise.resolve(); expect(emitted).toHaveLength(1);
    release(); await work; expect(emitted).toHaveLength(3);
    await zip.add("manifest.csv", manifest(), "manifest"); await zip.add("README.txt", readme(), "readme"); await zip.finish();
    const all = concatenate(emitted), end = new DataView(all.buffer, all.byteLength - 22);
    expect(end.getUint32(16, true) + end.getUint32(12, true) + 22).toBe(all.byteLength);
  });

  it("enforces replay/entry/name bounds and refuses success after failed output", async () => {
    const zip = new StoreZip(async () => {});
    await expect(zip.add("manifest.csv", encode("data"), "replay")).rejects.toThrow("invalid_zip_entry");
    await expect(zip.add("../bad.SC2Replay", encode("data"), "replay")).rejects.toThrow("invalid_zip_entry");
    await expect(zip.add("too-large.SC2Replay", new Uint8Array(REPLAY_BYTES + 1), "replay")).rejects.toThrow("invalid_zip_entry");
    for (let index = 0; index < 100; index += 1) await zip.add(`${index}.SC2Replay`, encode("data"), "replay");
    await expect(zip.add("101.SC2Replay", encode("data"), "replay")).rejects.toThrow("invalid_zip_entry");
    const broken = new StoreZip(async () => { throw new Error("private sink error"); });
    await expect(broken.add("one.SC2Replay", encode("data"), "replay")).rejects.toThrow();
    await expect(broken.add("two.SC2Replay", encode("data"), "replay")).rejects.toThrow("invalid_zip_state");
  });

  it("never admits distinct malformed surrogate names that TextEncoder would collapse into one ZIP path", async () => {
    const chunks: Uint8Array[] = [], zip = new StoreZip(async chunk => { chunks.push(chunk); });
    await expect(zip.add("bad\ud800.SC2Replay", encode("data"), "replay")).rejects.toThrow("invalid_zip_entry");
    await expect(zip.add("bad\ud801.SC2Replay", encode("data"), "replay")).rejects.toThrow("invalid_zip_entry");
    expect(chunks).toHaveLength(0);
    await zip.add("bad\ufffd.SC2Replay", encode("data"), "replay");
    expect(chunks).toHaveLength(2);
  });
});
