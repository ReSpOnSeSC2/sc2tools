import { sanitizeMapPlayback, type MapPlayback } from "./mapReplay";

export const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
export type PlaybackSegmentEntry = { index: number; start: number; end: number; sizeBytes: number; sha256: string; points: number };
export type PlaybackManifest = {
  artifactId: string;
  replaySha256: string;
  sourceArtifactSha256: string;
  mapName: string;
  gameLength: number;
  fidelity: NonNullable<MapPlayback["fidelity"]>;
  segments: PlaybackSegmentEntry[];
};
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const identical = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && identical(left[key], right[key]));
};

export function sanitizePlaybackManifest(raw: unknown): PlaybackManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const response = raw as Record<string, any>;
  const manifest = response.manifest;
  if (response.ok !== true || !hash(response.artifactId) || !manifest ||
    manifest.schema !== "sc2tools-playback-manifest-v1" || !hash(manifest.replaySha256) ||
    !hash(manifest.sourceArtifactSha256) || typeof manifest.mapName !== "string" ||
    !finite(manifest.gameLength) || manifest.gameLength <= 0 || manifest.gameLength > 86400 ||
    !Array.isArray(manifest.segments) || !manifest.segments.length || manifest.segments.length > 512) return null;
  const fidelity = manifest.fidelity;
  if (!fidelity || fidelity.positions !== "engine" || fidelity.paths !== "observed" || fidelity.complete !== true ||
    !["attacks", "effects", "creep"].every(key => fidelity[key] === "observed") ||
    !finite(fidelity.positionError) || fidelity.positionError < 0 || fidelity.positionError > .5 ||
    !finite(fidelity.sampleSeconds) || fidelity.sampleSeconds <= 0 || fidelity.sampleSeconds > .179) return null;
  const segments: PlaybackSegmentEntry[] = [];
  let priorEnd = 0;
  for (const [index, value] of manifest.segments.entries()) {
    if (!value || value.index !== index || value.start !== priorEnd || !finite(value.end) ||
      value.end <= value.start || value.end > manifest.gameLength || !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes <= 0 || value.sizeBytes > MAX_SEGMENT_BYTES || !hash(value.sha256) ||
      !Number.isInteger(value.points) || value.points < 0 || value.points > 60000) return null;
    segments.push({ index, start: value.start, end: value.end, sizeBytes: value.sizeBytes, sha256: value.sha256, points: value.points });
    priorEnd = value.end;
  }
  if (priorEnd !== manifest.gameLength) return null;
  return { artifactId: response.artifactId, replaySha256: manifest.replaySha256,
    sourceArtifactSha256: manifest.sourceArtifactSha256, mapName: manifest.mapName,
    gameLength: manifest.gameLength, fidelity, segments };
}

export function segmentAt(manifest: PlaybackManifest, time: number): PlaybackSegmentEntry {
  const clamped = Math.max(0, Math.min(manifest.gameLength, Number.isFinite(time) ? time : 0));
  return manifest.segments.find(value => clamped >= value.start && clamped < value.end) ?? manifest.segments[manifest.segments.length - 1];
}

/** Independent bounded cache; SWR never retains one heavy entry per segment. */
export class PlaybackSegmentCache {
  private entries = new Map<string, MapPlayback>();
  constructor(private readonly limit = 3) {}
  get size() { return this.entries.size; }
  get(key: string) {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: MapPlayback) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}

export async function decodePlaybackSegment(bytes: Uint8Array, manifest: PlaybackManifest, entry: PlaybackSegmentEntry): Promise<MapPlayback> {
  if (bytes.byteLength !== entry.sizeBytes || bytes.byteLength > MAX_SEGMENT_BYTES) throw new Error("Playback segment size did not match its manifest.");
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const actualHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  if (actualHash !== entry.sha256) throw new Error("Playback segment integrity check failed. Try reloading this replay.");
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (raw.schema !== "sc2tools-playback-segment-v1" || raw.replaySha256 !== manifest.replaySha256 ||
    raw.index !== entry.index || raw.start !== entry.start || raw.end !== entry.end ||
    raw.playback?.v !== 7 || raw.playback.mapName !== manifest.mapName || raw.playback.gameLength !== manifest.gameLength) {
    throw new Error("Playback segment did not belong to this replay and time range.");
  }
  const playback = sanitizeMapPlayback(raw.playback);
  if (!playback || playback.fidelity?.complete !== true || playback.fidelity.positions !== "engine" ||
    playback.gameLength !== manifest.gameLength ||
    playback.fidelity.positionError !== manifest.fidelity.positionError ||
    playback.fidelity.sampleSeconds !== manifest.fidelity.sampleSeconds ||
    ["paths", "creep", "attacks", "effects"].some(key =>
      playback.fidelity?.[key as keyof NonNullable<MapPlayback["fidelity"]>] !== "observed")) {
    throw new Error("Playback segment is incomplete or invalid.");
  }
  // The legacy sanitizer safely drops malformed/oversized fields. An exact
  // artifact must instead fail closed if any recorded channel was dropped.
  const source = raw.playback;
  for (const key of ["units", "buildings", "spawns", "battles", "resources", "casts", "effects"] as const) {
    const original = source[key] ?? [];
    const sanitized = playback[key] ?? [];
    if (!Array.isArray(original) || original.length !== sanitized.length) throw new Error("Playback segment exceeds browser channel limits.");
  }
  for (const key of ["units", "buildings"] as const) {
    for (let index = 0; index < playback[key].length; index++) {
      const original = source[key][index];
      const sanitized = playback[key][index] as unknown as Record<string, unknown>;
      for (const field of ["wp", "moves", "attacks", "aim", "forms", "hidden"]) {
        if (original[field]?.length && !identical(original[field], sanitized[field])) throw new Error("Playback segment lost a recorded entity channel.");
      }
    }
  }
  if (!identical(source.stats?.me ?? [], playback.stats.me) || !identical(source.stats?.opp ?? [], playback.stats.opp) ||
    (source.creep && !identical(source.creep, playback.creep))) throw new Error("Playback segment lost a recorded timeline channel.");
  const points = playback.units.reduce((total, unit) => total + unit.wp.length / 3, 0) +
    playback.buildings.reduce((total, building) => total + building.moves.length / 3, 0);
  if (points !== entry.points || points > 60000) throw new Error("Playback motion count did not match its manifest.");
  return playback;
}

export async function readBoundedSegment(response: Response, expectedBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Could not download playback segment (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Playback streaming is unavailable in this browser.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes || total > MAX_SEGMENT_BYTES) throw new Error("Playback segment exceeded its declared size.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  if (total !== expectedBytes) throw new Error("Playback segment download was incomplete.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
