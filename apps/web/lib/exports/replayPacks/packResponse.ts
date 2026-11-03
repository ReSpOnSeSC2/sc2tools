import { ExportDownloadError } from "../exportErrors";
import { validPackUnicode } from "./packNames";
import { readPackBytes, type PackWorkScope } from "./packReaders";
import { REPLAY_BYTES } from "./zipStore";

export const PACK_RESPONSE_BYTES = 1024 * 1024;
const ROW_BYTES = 8 * 1024;
export type ReadyReplay = { gameId: string; status: "available"; url: string; filename: string; sizeBytes: number; issuedAt: string; expiresAt: string };
export type UnreadyReplay = { gameId: string; status: "unavailable" | "retryable"; code: "replay_unavailable" | "replay_download_unavailable" | "replay_download_expired" };
export type SignedReplay = ReadyReplay | UnreadyReplay;
function invalid(): never { throw new ExportDownloadError("invalid"); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) invalid();
}
function text(value: unknown, cap: number, pattern: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= cap && validPackUnicode(value) && !pattern.test(value);
}
function instant(value: unknown): number {
  if (typeof value !== "string" || value.length > 64) invalid();
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || epoch % 1000 !== 0 || new Date(epoch).toISOString() !== value) invalid();
  return epoch;
}
function ready(row: Record<string, unknown>): ReadyReplay {
  keys(row, ["gameId", "status", "url", "filename", "sizeBytes", "issuedAt", "expiresAt"]);
  if (!text(row.url, 4096, /[\u0000-\u0020\u007f-\u009f]/u) || !text(row.filename, 255, /[\\/\u0000-\u001f\u007f-\u009f]/u)
    || typeof row.sizeBytes !== "number" || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 4 || row.sizeBytes > REPLAY_BYTES) invalid();
  try { const url = new URL(row.url); if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid(); } catch { invalid(); }
  if (instant(row.expiresAt) - instant(row.issuedAt) !== 60_000) invalid();
  return Object.freeze({ gameId: row.gameId as string, status: "available", url: row.url, filename: row.filename,
    sizeBytes: row.sizeBytes, issuedAt: row.issuedAt as string, expiresAt: row.expiresAt as string });
}

/** Exactly frozen C03 v1: no response owner or digest is invented. */
export function parsePackResponse(value: unknown, expectedIds: readonly string[]): readonly SignedReplay[] {
  const envelope = object(value); keys(envelope, ["format", "version", "items", "counts"]);
  if (envelope.format !== "sc2tools-replay-download-batch" || envelope.version !== 1 || !Array.isArray(envelope.items)
    || expectedIds.length < 1 || expectedIds.length > 4 || new Set(expectedIds).size !== expectedIds.length || envelope.items.length !== expectedIds.length) invalid();
  const declared = object(envelope.counts); keys(declared, ["requested", "available", "unavailable", "retryable"]);
  const counts = { requested: expectedIds.length, available: 0, unavailable: 0, retryable: 0 };
  const items: SignedReplay[] = envelope.items.map((raw, index) => {
    const row = object(raw);
    if (typeof row.gameId !== "string" || row.gameId !== expectedIds[index] || new TextEncoder().encode(JSON.stringify(row)).byteLength > ROW_BYTES) invalid();
    if (row.status === "available") { counts.available++; return ready(row); }
    keys(row, ["gameId", "status", "code"]);
    if (row.status !== "unavailable" && row.status !== "retryable") invalid();
    if ((row.status === "unavailable" && row.code !== "replay_unavailable")
      || (row.status === "retryable" && row.code !== "replay_download_unavailable" && row.code !== "replay_download_expired")) invalid();
    counts[row.status]++;
    return Object.freeze({ gameId: row.gameId as string, status: row.status, code: row.code } as UnreadyReplay);
  });
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) if (declared[key] !== counts[key]) invalid();
  return Object.freeze(items);
}

export async function readPackResponse(response: Response, expectedIds: readonly string[], scope: PackWorkScope): Promise<readonly SignedReplay[]> {
  const bytes = await readPackBytes(response, scope, PACK_RESPONSE_BYTES);
  scope.assertCurrent();
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") invalid();
  try { return parsePackResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), expectedIds); }
  catch (error) { throw error instanceof ExportDownloadError ? error : new ExportDownloadError("invalid"); }
}
