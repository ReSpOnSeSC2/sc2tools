import { MAX_REPLAY_BYTES, isReplayFileName } from "@/lib/instant/fileIntake";
import { replayDigest } from "@/lib/instant/replayDigest";
import { toonFromPath } from "@/lib/instant/toonPath";
import type { EngineProgress, IntakeFile, ReplayHeaderEngineClient, ReplayHeaderResult } from "@/lib/instant/types";
import { readCareerCache, saveCareerCache, type CachedHeader } from "./careerCache";
import { isLadderHeader, type KeyedHeader } from "./headerRows";

export type CareerScan = {
  rows: KeyedHeader[];
  reused: number;
  unreadable: number;
  cacheAvailable: boolean;
};

type Candidate = { file: IntakeFile; digest: string | null };
type Job = { entries: Candidate[]; missing: Candidate[] };
export type CareerProgress = { phase: "files" | "headers"; complete: number; total: number };
type ScanOptions = {
  signal: AbortSignal;
  onProgress: (progress: CareerProgress) => void;
};

async function prepareScan(files: IntakeFile[], rows: Map<string, CachedHeader> | undefined, { signal, onProgress }: ScanOptions): Promise<Job> {
  const seen = new Set(rows?.keys());
  const entries: Candidate[] = [];
  const missing: Candidate[] = [];
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    const digest = await replayDigest(file.blob);
    signal.throwIfAborted();
    const entry = { file, digest };
    entries.push(entry);
    const complete = index + 1;
    if (complete === 1 || complete === files.length || complete % 100 === 0) {
      onProgress({ phase: "files", complete, total: files.length });
    }
    if (digest) {
      if (seen.has(digest)) continue;
      seen.add(digest);
    }
    missing.push(entry);
  }
  return { entries, missing };
}

function reportProgress({ signal, onProgress }: ScanOptions) {
  return ({ phase, index, total, ok }: EngineProgress) => {
    if (signal.aborted || phase !== "header" || ok === undefined) return;
    const complete = index + 1;
    if (complete === 1 || complete === total || complete % 10 === 0) onProgress({ phase: "headers", complete, total });
  };
}

async function scanMisses(missing: Candidate[], options: ScanOptions): Promise<ReplayHeaderResult[]> {
  if (!missing.length) return [];
  const { createEngineClient } = await import("@/lib/instant/engineClient");
  options.signal.throwIfAborted();
  const engine: ReplayHeaderEngineClient = createEngineClient({ refreshPolicy: false });
  options.onProgress({ phase: "headers", complete: 0, total: missing.length });
  try {
    return await engine.scanHeaders(missing.map(({ file }) => file), {
      signal: options.signal, onProgress: reportProgress(options),
    });
  } finally {
    engine.dispose();
  }
}

function collectResults(job: Job, scanned: ReplayHeaderResult[], cached: Map<string, CachedHeader> | undefined) {
  const values = new Map<string | IntakeFile, CachedHeader>(cached);
  job.missing.forEach(({ digest, file }, index) => {
    const parsed = scanned[index];
    if (parsed?.ok) {
      values.set(digest ?? file, isLadderHeader(parsed) ? { ...parsed, toonFromPath: null } : null);
    }
  });
  const rows: KeyedHeader[] = [];
  const retained = new Map<string, CachedHeader>();
  let reused = 0;
  let unreadable = 0;
  for (const [index, { file, digest }] of job.entries.entries()) {
    const header = values.get(digest ?? file);
    if (header === undefined) {
      unreadable++;
      continue;
    }
    if (digest) {
      retained.set(digest, header);
      if (cached?.has(digest)) reused++;
    }
    if (header) rows.push({
      key: String(index),
      replayDigest: digest ?? undefined,
      header: { ...header, toonFromPath: toonFromPath(file.relativePath) },
    });
  }
  return { rows, reused, unreadable, retained };
}

/** The selected files are the source of truth. Storage only avoids parsing them again. */
export async function scanCareer(files: IntakeFile[], options: ScanOptions): Promise<CareerScan | null> {
  const candidates = files.filter((file) => isReplayFileName(file.name));
  if (!candidates.length) return null;
  const eligible = candidates.filter((file) => file.size > 0 && file.size <= MAX_REPLAY_BYTES);
  const cache = await readCareerCache();
  options.signal.throwIfAborted();
  const job = await prepareScan(eligible, cache?.rows, options);
  const scanned = await scanMisses(job.missing, options);
  options.signal.throwIfAborted();
  const { rows, reused, unreadable, retained } = collectResults(job, scanned, cache?.rows);
  const totalUnreadable = candidates.length - eligible.length + unreadable;
  if (totalUnreadable === candidates.length) throw new Error("Could not read the selected replays");
  const unchanged = reused === eligible.length && retained.size === cache?.rows.size;
  const cacheAvailable = cache !== null && (unchanged || await saveCareerCache({ ...cache, rows: retained }, options.signal));
  options.signal.throwIfAborted();
  return { rows, reused, unreadable: totalUnreadable, cacheAvailable };
}
