/**
 * Changed-since reads of the analysis corpus (`GET /v1/games/analysis-corpus/changes`): read every page after a
 * snapshot's or the last delta's marks, then merge the changes into the rows held so far.
 *
 * Whatever only a snapshot can resolve reads as null: the server asked for one (a changed corpus version, corpus rules
 * from another epoch, or a watermark from before change stamps), the server predates the route (404 during a rolling
 * deploy), the version or epoch moved between pages, a page was malformed, or the delta ran longer than a snapshot.
 *
 * Example:
 *   const delta = await readCorpusChanges(fetchPage, marks, { limit: 2000, maxPages: 10 });
 *   if (delta) rows = mergeCorpusChanges(rows, delta.changes);
 */

export const CORPUS_CHANGES_PATH = "/v1/games/analysis-corpus/changes";

/**
 * What a snapshot's first page or a delta's last page hands back: the owner's corpus version, the epoch of the corpus
 * rules the rows were built under, and the watermark to ask from next.
 */
export type CorpusMarks = { corpusVersion: number; watermark: string; corpusEpoch: string };

export type CorpusRow = { gameId: string };

/** A game that left the corpus: deleted, hidden, pending deletion or quarantined. */
export type CorpusRemoval = { gameId: string; removed: true };

export type CorpusChange<T extends CorpusRow> = T | CorpusRemoval;

export type CorpusDelta<T extends CorpusRow> = {
  changes: CorpusChange<T>[];
  marks: CorpusMarks;
  pages: number;
};

export function isRemoval<T extends CorpusRow>(
  change: CorpusChange<T>,
): change is CorpusRemoval {
  return (change as Partial<CorpusRemoval>).removed === true;
}

/**
 * The marks on a snapshot's first page, or null from a server that sends none (or none complete).
 *
 * Example:
 *   snapshotMarks({ items: [], corpusVersion: 2, watermark: "2026-10-31T00:00:00.000Z", corpusEpoch: "1.0a1b" });
 */
export function snapshotMarks(page: unknown): CorpusMarks | null {
  const marks = page as Partial<CorpusMarks> | null;
  if (!marks || typeof marks !== "object") return null;
  const { corpusVersion, watermark, corpusEpoch } = marks;
  return isVersion(corpusVersion) && isWatermark(watermark) && isEpoch(corpusEpoch)
    ? { corpusVersion, watermark, corpusEpoch }
    : null;
}

/**
 * Build one changes URL; the cursor stays opaque to the browser.
 *
 * Example:
 *   changesPath({ corpusVersion: 0, watermark: "2026-10-31T00:00:00.000Z", corpusEpoch: "1.0a1b" }, 2000);
 */
export function changesPath(
  marks: CorpusMarks,
  limit: number,
  cursor?: string,
): string {
  const query = new URLSearchParams({
    since: marks.watermark,
    corpus_version: String(marks.corpusVersion),
    corpus_epoch: marks.corpusEpoch,
    limit: String(limit),
  });
  if (cursor) query.set("cursor", cursor);
  return `${CORPUS_CHANGES_PATH}?${query.toString()}`;
}

/**
 * Read every page of changes after `marks`, or null when only a snapshot can bring the rows up to date. Network
 * failures other than a missing route reject, as a snapshot page's would.
 *
 * Example:
 *   const delta = await readCorpusChanges((path) => apiCall(getToken, path), marks, { limit: 2000, maxPages: 10 });
 */
export async function readCorpusChanges<T extends CorpusRow>(
  fetchPage: (path: string) => Promise<unknown>,
  marks: CorpusMarks,
  { limit, maxPages }: { limit: number; maxPages: number },
): Promise<CorpusDelta<T> | null> {
  const changes: CorpusChange<T>[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await fetchChangesPage(fetchPage, changesPath(marks, limit, cursor));
    const items = pageItems<T>(body, marks);
    if (!items) return null;
    changes.push(...items);
    const { nextCursor, watermark } = body as { nextCursor?: unknown; watermark?: unknown };
    if (typeof nextCursor === "string" && nextCursor) {
      cursor = nextCursor;
      continue;
    }
    if (!isWatermark(watermark)) return null;
    return { changes, marks: { ...marks, watermark }, pages: page };
  }
  // More pages than a full snapshot takes: the snapshot is the cheaper read.
  return null;
}

/**
 * Apply changes in order, the latest per game winning, and return the rows newest first as a snapshot serves them.
 *
 * Example:
 *   mergeCorpusChanges([older, removed], [{ gameId: removed.gameId, removed: true }, newest]); // [newest, older]
 */
export function mergeCorpusChanges<T extends CorpusRow & { date?: unknown }>(
  rows: readonly T[],
  changes: readonly CorpusChange<T>[],
): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.gameId, row);
  for (const change of changes) {
    if (isRemoval(change)) byId.delete(change.gameId);
    else byId.set(change.gameId, change);
  }
  return newestFirst([...byId.values()]);
}

/**
 * Order rows newest first by `date`. Rows without a readable date go last, and ties keep their order.
 *
 * Example:
 *   newestFirst([{ date: "2026-01-01" }, { date: "2026-02-01" }]); // February first
 */
export function newestFirst<T extends { date?: unknown }>(rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, at: dateValue(row.date) }))
    .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
    .map(({ row }) => row);
}

async function fetchChangesPage(
  fetchPage: (path: string) => Promise<unknown>,
  path: string,
): Promise<unknown> {
  try {
    return await fetchPage(path);
  } catch (error) {
    // A server from before the route answers 404 while a deploy rolls: snapshot only.
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
}

function pageItems<T extends CorpusRow>(
  body: unknown,
  marks: CorpusMarks,
): CorpusChange<T>[] | null {
  const page = body as {
    corpusVersion?: unknown;
    corpusEpoch?: unknown;
    items?: unknown;
    snapshotRequired?: unknown;
  } | null;
  if (!page || typeof page !== "object" || page.snapshotRequired !== undefined) return null;
  if (page.corpusVersion !== marks.corpusVersion || page.corpusEpoch !== marks.corpusEpoch) return null;
  if (!Array.isArray(page.items)) return null;
  return page.items.every(isChange) ? (page.items as CorpusChange<T>[]) : null;
}

function isChange(item: unknown): boolean {
  return Boolean(item) && typeof item === "object" && typeof (item as Partial<CorpusRow>).gameId === "string";
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWatermark(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isEpoch(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z.]{1,64}$/.test(value);
}

function dateValue(date: unknown): number {
  const at = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}
