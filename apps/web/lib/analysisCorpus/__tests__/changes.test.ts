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

const EPOCH = "1.0123456789abcdef";
const MARKS: CorpusMarks = { corpusVersion: 3, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: EPOCH };
const LIMITS = { limit: 2, maxPages: 3 };

function game(gameId: string, date = "2026-10-31T09:00:00.000Z") {
  return { gameId, date, result: "Victory" };
}

function page(items: unknown[], extra: Record<string, unknown> = {}) {
  return { items, nextCursor: null, watermark: "2026-10-31T11:00:00.000Z", corpusVersion: 3, corpusEpoch: EPOCH, ...extra };
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
  it("reads the version, watermark and epoch a snapshot's first page carries", () => {
    expect(snapshotMarks({ items: [], ...MARKS })).toEqual(MARKS);
  });

  it("returns null from a server that sends none, sends them partly or sends them malformed", () => {
    expect(snapshotMarks({ items: [], nextCursor: null })).toBeNull();
    expect(snapshotMarks({ corpusVersion: 3, watermark: MARKS.watermark })).toBeNull();
    expect(snapshotMarks({ ...MARKS, corpusVersion: -1 })).toBeNull();
    expect(snapshotMarks({ ...MARKS, watermark: "yesterday" })).toBeNull();
    expect(snapshotMarks({ ...MARKS, corpusEpoch: "not an epoch" })).toBeNull();
    expect(snapshotMarks(null)).toBeNull();
  });
});

describe("readCorpusChanges", () => {
  it("follows the cursor to the final page and returns its watermark", async () => {
    const fetchPage = pages(
      page([game("g1")], { nextCursor: "next", watermark: null }),
      page([{ gameId: "g2", removed: true }]),
    );
    const delta = await readCorpusChanges(fetchPage, MARKS, LIMITS);
    expect(delta).toEqual({
      changes: [game("g1"), { gameId: "g2", removed: true }],
      marks: { ...MARKS, watermark: "2026-10-31T11:00:00.000Z" },
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
      corpus_epoch: EPOCH,
      limit: "2",
    });
  });

  it("needs a snapshot when the server asks for one, the route is missing, or a page is wrong", async () => {
    const cases = [
      [{ snapshotRequired: "corpus_version", corpusVersion: 4, corpusEpoch: EPOCH }],
      [{ snapshotRequired: "corpus_epoch", corpusVersion: 3, corpusEpoch: "2.fedcba9876543210" }],
      [{ snapshotRequired: "before_stamps", corpusVersion: 3, corpusEpoch: EPOCH, deltasFrom: MARKS.watermark }],
      [Object.assign(new Error("Not found"), { status: 404 })],
      [page([game("g1")], { nextCursor: "next", watermark: null }), page([], { corpusVersion: 4 })],
      [page([game("g1")], { nextCursor: "next", watermark: null }), page([], { corpusEpoch: "2.fedcba9876543210" })],
      [page([game("g1")], { corpusEpoch: undefined })],
      [page([{ removed: true }])],
      [page([game("g1")], { watermark: null })],
      [page("nope" as unknown as unknown[])],
    ];
    for (const bodies of cases) {
      await expect(readCorpusChanges(pages(...bodies), MARKS, LIMITS)).resolves.toBeNull();
    }
  });

  it("prefers a snapshot to a delta longer than one, and lets other failures through", async () => {
    const more = page([game("g1")], { nextCursor: "next", watermark: null });
    const fetchPage = pages(more, more, more, more);
    await expect(readCorpusChanges(fetchPage, MARKS, LIMITS)).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(readCorpusChanges(pages(busy), MARKS, LIMITS)).rejects.toBe(busy);
  });
});

describe("mergeCorpusChanges", () => {
  it("replaces, removes and adds games, newest first, without touching the rows it was given", () => {
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

  it("applies changes to one game in order, the latest winning", () => {
    const rows = [game("kept"), game("put-then-removed"), game("removed-then-put")];
    const merged = mergeCorpusChanges(rows, [
      { ...game("put-then-removed"), result: "Defeat" },
      { gameId: "put-then-removed", removed: true },
      { gameId: "removed-then-put", removed: true },
      { ...game("removed-then-put"), result: "Defeat" },
      { ...game("kept"), result: "Tie" },
      { ...game("kept"), result: "Defeat" },
    ]);
    expect(merged.map((row) => [row.gameId, row.result]).sort()).toEqual([
      ["kept", "Defeat"], ["removed-then-put", "Defeat"],
    ]);
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
