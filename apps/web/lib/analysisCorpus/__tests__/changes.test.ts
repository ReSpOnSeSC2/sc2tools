import { describe, expect, it, vi } from "vitest";
import {
  CORPUS_CHANGES_PATH,
  changesPath,
  mergeCorpusChanges,
  newestFirst,
  readCorpusChanges,
  snapshotMarks,
  type CorpusMarks,
} from "../changes";

const MARKS: CorpusMarks = { corpusVersion: 3, watermark: "2026-10-31T10:00:00.000Z" };
const LIMITS = { limit: 2, maxPages: 3 };

function game(gameId: string, date = "2026-10-31T09:00:00.000Z") {
  return { gameId, date, result: "Victory" };
}

function pages(...bodies: unknown[]) {
  const fetchPage = vi.fn();
  for (const body of bodies) {
    if (body instanceof Error) fetchPage.mockRejectedValueOnce(body);
    else fetchPage.mockResolvedValueOnce(body);
  }
  return fetchPage;
}

describe("snapshotMarks", () => {
  it("reads the version and watermark a snapshot's first page carries", () => {
    expect(snapshotMarks({ items: [], ...MARKS })).toEqual(MARKS);
  });

  it("returns null from a server that sends none or sends them malformed", () => {
    expect(snapshotMarks({ items: [], nextCursor: null })).toBeNull();
    expect(snapshotMarks({ corpusVersion: -1, watermark: MARKS.watermark })).toBeNull();
    expect(snapshotMarks({ corpusVersion: 1, watermark: "yesterday" })).toBeNull();
    expect(snapshotMarks(null)).toBeNull();
  });
});

describe("readCorpusChanges", () => {
  it("follows the cursor to the final page and returns its watermark", async () => {
    const fetchPage = pages(
      { items: [game("g1")], nextCursor: "next", watermark: null, corpusVersion: 3 },
      { items: [{ gameId: "g2", removed: true }], nextCursor: null, watermark: "2026-10-31T11:00:00.000Z", corpusVersion: 3 },
    );
    const delta = await readCorpusChanges(fetchPage, MARKS, LIMITS);
    expect(delta).toEqual({
      changes: [game("g1"), { gameId: "g2", removed: true }],
      marks: { corpusVersion: 3, watermark: "2026-10-31T11:00:00.000Z" },
      pages: 2,
    });
    expect(fetchPage.mock.calls.map(([path]) => path)).toEqual([
      changesPath(MARKS, 2),
      changesPath(MARKS, 2, "next"),
    ]);
    const first = new URL(fetchPage.mock.calls[0][0], "https://example.test");
    expect(first.pathname).toBe(CORPUS_CHANGES_PATH);
    expect(Object.fromEntries(first.searchParams)).toEqual({
      since: MARKS.watermark,
      corpus_version: "3",
      limit: "2",
    });
  });

  it("needs a snapshot when the server asks for one, the route is missing, or a page is wrong", async () => {
    const final = { nextCursor: null, watermark: MARKS.watermark, corpusVersion: 3 };
    const cases = [
      [{ snapshotRequired: "corpus_version", corpusVersion: 4 }],
      [{ snapshotRequired: "before_stamps", corpusVersion: 3, deltasFrom: MARKS.watermark }],
      [Object.assign(new Error("Not found"), { status: 404 })],
      [{ ...final, items: [game("g1")], nextCursor: "next", watermark: null }, { ...final, items: [], corpusVersion: 4 }],
      [{ ...final, items: [{ removed: true }] }],
      [{ ...final, items: [game("g1")], watermark: null }],
      [{ ...final, items: "nope" }],
    ];
    for (const bodies of cases) {
      await expect(readCorpusChanges(pages(...bodies), MARKS, LIMITS)).resolves.toBeNull();
    }
  });

  it("prefers a snapshot to a delta longer than one, and lets other failures through", async () => {
    const more = { items: [game("g1")], nextCursor: "next", watermark: null, corpusVersion: 3 };
    const fetchPage = pages(more, more, more, more);
    await expect(readCorpusChanges(fetchPage, MARKS, LIMITS)).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(readCorpusChanges(pages(busy), MARKS, LIMITS)).rejects.toBe(busy);
  });
});

describe("mergeCorpusChanges", () => {
  it("replaces, removes and adds games, newest first, with the latest change winning", () => {
    const rows = [game("a", "2026-10-30T00:00:00.000Z"), game("b", "2026-10-29T00:00:00.000Z")];
    const merged = mergeCorpusChanges(rows, [
      { ...game("a", "2026-10-30T00:00:00.000Z"), result: "Defeat" },
      { gameId: "b", removed: true },
      game("c", "2026-10-31T00:00:00.000Z"),
      { gameId: "missing", removed: true },
    ]);
    expect(merged.map((row) => [row.gameId, row.result])).toEqual([["c", "Victory"], ["a", "Defeat"]]);
    expect(rows.map((row) => row.result)).toEqual(["Victory", "Victory"]);
  });

  it("keeps ties in their order and puts undated games last", () => {
    const rows = [
      { gameId: "undated", date: null },
      game("tie-1", "2026-10-30T00:00:00.000Z"),
      game("tie-2", "2026-10-30T00:00:00.000Z"),
      game("newest", "2026-10-31T00:00:00.000Z"),
    ];
    expect(newestFirst(rows).map((row) => row.gameId)).toEqual(["newest", "tie-1", "tie-2", "undated"]);
  });
});
