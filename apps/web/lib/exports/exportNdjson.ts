import { ExportDownloadError } from "./exportErrors";

/** apiOwner is the API's internal userId, distinct from the Clerk cancellation identity. */
export type ExportFormat = { format: "sc2tools-account-export"; apiOwner: string } | { format: "sc2tools-build-order-export" };
const FIELDS = ["gameId", "side", "time", "supply", "name"];
const MAX_RECORD_BYTES = 17 * 1024 * 1024;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function invalid(): never { throw new ExportDownloadError("invalid"); }

/** Retains one bounded line and collection counts, never the account's rows. */
export class ExportNdjson {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private pendingBytes = 0;
  private metadata = false;
  private complete = false;
  private user = false;
  private counts = new Map<string, number>();
  private events = 0;
  private games = 0;
  continuation: string | null = null;

  constructor(private expected: ExportFormat) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(start, index + 1));
      this.record(this.pending.slice(0, -1));
      this.pending = ""; this.pendingBytes = 0; start = index + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
  }

  private append(bytes: Uint8Array): void {
    this.pendingBytes += bytes.byteLength;
    if (this.pendingBytes > MAX_RECORD_BYTES) throw new ExportDownloadError("too_large");
    try { this.pending += this.decoder.decode(bytes, { stream: true }); } catch { invalid(); }
  }

  private record(line: string): void {
    if (this.complete) invalid();
    let value: unknown;
    try { value = JSON.parse(line); } catch { invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const row = value as Record<string, unknown>;
    if (!this.metadata) { this.header(row); return; }
    if (row.type === "metadata") invalid();
    if (this.expected.format === "sc2tools-account-export") this.account(row);
    else this.buildOrders(row);
  }

  private header(row: Record<string, unknown>): void {
    if (row.type !== "metadata" || row.format !== this.expected.format || row.version !== 1) invalid();
    if (this.expected.format === "sc2tools-account-export") {
      if (row.userId !== this.expected.apiOwner) invalid();
    } else {
      if (!count(row.games) || row.games > 2000 || JSON.stringify(row.fields) !== JSON.stringify(FIELDS)) invalid();
      this.games = row.games;
    }
    this.metadata = true;
  }

  private account(row: Record<string, unknown>): void {
    if (row.type === "collection") {
      if (typeof row.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(row.name) || this.counts.has(row.name) || this.counts.size >= 256) invalid();
      this.counts.set(row.name, 0);
    } else if (row.type === "record") {
      if (typeof row.collection !== "string" || !this.counts.has(row.collection) || !Object.hasOwn(row, "row")) invalid();
      this.counts.set(row.collection, this.counts.get(row.collection)! + 1);
    } else if (row.type === "user") {
      if (this.user || !Object.hasOwn(row, "row")) invalid();
      this.user = true;
    } else if (row.type === "complete") {
      if (!this.user || !row.counts || typeof row.counts !== "object" || Array.isArray(row.counts)) invalid();
      const counts = row.counts as Record<string, unknown>;
      if (Object.keys(counts).length !== this.counts.size) invalid();
      for (const [name, total] of this.counts) if (!count(counts[name]) || counts[name] !== total) invalid();
      this.complete = true;
    } else invalid();
  }

  private buildOrders(row: Record<string, unknown>): void {
    if (row.type === "complete") {
      if (row.games !== this.games || row.events !== this.events) invalid();
      if (row.continuation !== null && (typeof row.continuation !== "string" || !row.continuation.length || row.continuation.length > 4096 || /[\u0000-\u001f\u007f]/u.test(row.continuation))) invalid();
      this.continuation = row.continuation as string | null; this.complete = true;
      return;
    }
    if (Object.keys(row).sort().join(",") !== [...FIELDS].sort().join(",")) invalid();
    if (typeof row.gameId !== "string" || !row.gameId || row.gameId.length > 200 || /[\u0000-\u001f\u007f]/u.test(row.gameId) || !["me", "opponent"].includes(row.side as string)) invalid();
    const supply = row.supply;
    const exactOwnerSupply = row.side === "me" && typeof supply === "number" && Number.isFinite(supply) && supply >= 0 && supply <= 2000;
    if (!count(row.time) || (supply !== null && !exactOwnerSupply)) invalid();
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.name)) invalid();
    this.events++;
  }

  finish(): void {
    try { if (this.decoder.decode()) invalid(); } catch { invalid(); }
    if (this.pending || !this.metadata || !this.complete) throw new ExportDownloadError("incomplete");
  }
}
