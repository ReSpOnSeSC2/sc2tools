// @vitest-environment node
import { describe, expect, it } from "vitest";
import { replayFilenameAllocator, validReplayFilename, foldPackName, PACK_NAME_BYTES, type PackNameTemplate } from "./packNames";
import { replayPackManifest, replayPackReadme, type PackManifestRow } from "./packMetadata";

describe("private replay pack names and metadata", () => {
  it.each(["CON", "aux.txt", "COM1", "LPT\u00b2", "CONIN$", "../README.txt", "..\\manifest.csv", ".", "\u202eevil\u2066", "bad\u0000name", "name. "])("sanitizes %j and forces the replay extension outside reserved metadata namespaces", gameId => {
    const name = replayFilenameAllocator()({ gameId }, "game-id");
    expect(validReplayFilename(name)).toBe(true); expect(name.endsWith(".SC2Replay")).toBe(true);
    expect(["manifest.csv", "readme.txt"]).not.toContain(foldPackName(name));
    expect(name).not.toMatch(/[\\/\u0000\u202e\u2066]/u);
  });

  it("bounds UTF8 without splitting characters and allocates deterministic full case-fold collisions", () => {
    const allocate = replayFilenameAllocator();
    const first = allocate({ gameId: "straße" }, "game-id"), second = allocate({ gameId: "STRASSE" }, "game-id");
    expect(first).toBe("straße.SC2Replay"); expect(second).toBe("STRASSE (2).SC2Replay");
    const long = allocate({ gameId: "\u6226\ud83c\udfae".repeat(200) }, "game-id");
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(PACK_NAME_BYTES);
    expect(long).not.toContain("\ufffd"); expect(validReplayFilename(long)).toBe(true);
    const malformed = allocate({ gameId: "bad\ud800name" }, "game-id"); expect(malformed).not.toContain("\ud800");
  });

  it("uses only whitelisted templates and selected safe metadata, never private URLs as names", () => {
    const allocate = replayFilenameAllocator();
    expect(allocate({ gameId: "id", date: "2026-11-03", opponent: "Player", map: "Map", matchup: "PvT" }, "date-opponent-map"))
      .toBe("2026-11-03_Player_Map.SC2Replay");
    expect(allocate({ gameId: "https://private.invalid/replay?signature=secret" }, "game-id")).toBe("replay.SC2Replay");
    expect(() => allocate({ gameId: "id" }, "manifest.csv" as PackNameTemplate)).toThrow("invalid_pack_filename");
    expect(() => allocate({ gameId: "id" }, "README.txt" as PackNameTemplate)).toThrow("invalid_pack_filename");
  });

  it("escapes spreadsheet formulas, CSV quotes and line breaks while ignoring all URL/token/path fields", () => {
    const rows: PackManifestRow[] = [{ gameId: "=1+1", filename: "safe.SC2Replay", date: "2026-11-03", map: '=SUM("x",1)\nnext',
      opponent: "+Player", matchup: "PvT", status: "saved" }];
    Object.assign(rows[0], { token: "private-token", objectKey: "private/storage/path" });
    Object.defineProperty(rows[0], "url", { get: () => { throw new Error("private-url must not be read"); } });
    const text = new TextDecoder().decode(replayPackManifest(rows));
    expect(text).toContain('"\'=1+1"'); expect(text).toContain('"\'=SUM(""x"",1) next"'); expect(text).toContain('"\'+Player"');
    expect(text.split("\r\n")).toHaveLength(3); expect(text).not.toMatch(/private-token|storage\/path|private-url/);
    const redacted = new TextDecoder().decode(replayPackManifest([{ ...rows[0], gameId: "id", map: "https://private.invalid?signature=secret", opponent: "Bearer private-secret" }]));
    expect(redacted).not.toContain("private"); expect(redacted).not.toContain("signature");
  });

  it("keeps fixed partial-result facts and rejects malformed or reserved success filenames", () => {
    const readme = new TextDecoder().decode(replayPackReadme({ requested: 3, saved: 1, failed: 1, cancelled: 1 }));
    expect(readme).toContain("Selected: 3. Replay files saved: 1. Unavailable or failed: 1. Cancelled: 1.");
    expect(readme).toContain("Keep this archive private"); expect(readme).not.toMatch(/https?:\/\/|signature=|Bearer /u);
    expect(() => replayPackReadme({ requested: 3, saved: 3, failed: 1, cancelled: 0 })).toThrow("invalid_pack_summary");
    expect(() => replayPackManifest([{ gameId: "one", filename: "manifest.csv", status: "saved" }])).toThrow("invalid_pack_manifest");
    expect(() => replayPackManifest([{ gameId: "one", filename: "README.txt", status: "saved" }])).toThrow("invalid_pack_manifest");
  });

  it.each(["ｈｔｔｐｓ：／／private.invalid／object？signature＝private-normalized-sentinel", "Ｂｅａｒｅｒ　private-normalized-sentinel", "Ｘ－Ａｍｚ－Ｓｉｇｎａｔｕｒｅ＝private-normalized-sentinel"])(
    "screens URL/credential values after NFKC, excluding normalized private plaintext: %s", privateValue => {
      const text = new TextDecoder().decode(replayPackManifest([{ gameId: "one", filename: "one.SC2Replay", status: "saved", map: privateValue, opponent: privateValue, matchup: privateValue }]));
      expect(text).not.toContain("private-normalized-sentinel"); expect(text).not.toContain("private.invalid");
      expect(text).not.toContain("Signature"); expect(text).not.toContain("Bearer");
      const readme = new TextDecoder().decode(replayPackReadme(Object.assign({ requested: 1, saved: 1, failed: 0, cancelled: 0 }, { url: privateValue, token: privateValue })));
      expect(readme).not.toContain("private-normalized-sentinel"); expect(readme).not.toContain("private.invalid");
    });

  it("rejects malformed UTF16 before encoding and makes repaired metadata collisions distinct", () => {
    expect(validReplayFilename("bad\ud800.SC2Replay")).toBe(false); expect(validReplayFilename("bad\ud801.SC2Replay")).toBe(false);
    expect(validReplayFilename("bad\ufffd.SC2Replay")).toBe(true);
    const allocate = replayFilenameAllocator(), first = allocate({ gameId: "bad\ud800" }, "game-id"), second = allocate({ gameId: "bad\ud801" }, "game-id");
    expect(first).toBe("bad_.SC2Replay"); expect(second).toBe("bad_ (2).SC2Replay");
    expect([...new TextEncoder().encode(first)]).not.toEqual([...new TextEncoder().encode(second)]);
    expect(validReplayFilename("ＣＯＮ.SC2Replay")).toBe(false);
  });
});
