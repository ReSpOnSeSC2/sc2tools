import type { LockerState, LockerStudent } from "./lockerRosterModel";

export const SHELF_KINDS = {
  notes: "Session notes", voice: "Voice memo", video: "Video", image: "Screenshot",
  replay: "Replay", pdf: "PDF",
} as const;
export type ShelfKind = keyof typeof SHELF_KINDS;
export type ShelfItem = Record<string, unknown> & { id: string; t?: string; n?: string; d?: string; ty?: string; asset?: string; link?: string };
export type ShelfAsset = { n: string; mime: string; b64: string; size: number };
export const MAX_SHELF_FILE_BYTES = 6 * 1024 * 1024;

export function shelfItems(raw: unknown): ShelfItem[] {
  return Array.isArray(raw) ? raw.filter((row): row is ShelfItem => !!row && typeof row.id === "string") : [];
}

export function shelfTitle(item: ShelfItem): string {
  return typeof item.t === "string" && item.t.trim() ? item.t : "Untitled item";
}

export function shelfLink(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048 || /[\\\x00-\x1f]/.test(raw)) return null;
  try {
    const value = raw.trim();
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

const PASSIVE_MIME: Partial<Record<ShelfKind, RegExp>> = {
  voice: /^audio\/(?:webm|mp4|mpeg|ogg|wav|x-wav)(?:;codecs=[\w.-]+)?$/i,
  video: /^video\/(?:webm|mp4|ogg|quicktime)(?:;codecs=[\w.-]+)?$/i,
  image: /^image\/(?:png|jpe?g|webp|gif|avif)$/i,
};

export function shelfAsset(state: LockerState, item: ShelfItem): ShelfAsset | null {
  const assets = state.assets;
  if (!assets || typeof assets !== "object" || typeof item.asset !== "string" || !Object.hasOwn(assets, item.asset)) return null;
  const asset = (assets as Record<string, Partial<ShelfAsset>>)[item.asset];
  if (!asset || typeof asset.n !== "string" || typeof asset.mime !== "string" || typeof asset.b64 !== "string") return null;
  return { n: asset.n, mime: asset.mime, b64: asset.b64, size: asset.size ?? 0 };
}

export function mediaSource(kind: ShelfKind, asset: ShelfAsset | null): string | undefined {
  if (!asset || !PASSIVE_MIME[kind]?.test(asset.mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.b64)) return undefined;
  return `data:${asset.mime};base64,${asset.b64}`;
}

export async function readShelfFile(file: File, kind: ShelfKind): Promise<ShelfAsset> {
  const mime = file.type || "application/octet-stream";
  const accepted = kind === "replay" ? /\.sc2replay$/i.test(file.name)
    : kind === "pdf" ? mime === "application/pdf" || /\.pdf$/i.test(file.name) : PASSIVE_MIME[kind]?.test(mime);
  if (!accepted) throw new Error("Choose a file that matches the item type.");
  if (!file.size || file.size > MAX_SHELF_FILE_BYTES) throw new Error("Choose a file up to 6 MiB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const payload = String(reader.result).split(",", 2)[1];
      if (payload) resolve({ n: file.name.slice(0, 240), mime, b64: payload, size: file.size });
      else reject(new Error("The file could not be read."));
    };
    reader.readAsDataURL(file);
  });
}

export function downloadShelfFile(asset: ShelfAsset): void {
  const bytes = Uint8Array.from(atob(asset.b64), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = asset.n.replace(/[/\\\x00-\x1f]/g, "_");
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reusableShelfItem(item: ShelfItem): boolean {
  const link = shelfLink(item.link);
  return item.ty !== "replay" && !item.game && !(link && /\/app\/(?:game|replay)\//i.test(link));
}

export function cloneShelfItem(item: ShelfItem, id: string, date?: string): ShelfItem {
  const copy = structuredClone(item);
  copy.id = id;
  if (date) copy.d = date;
  else delete copy.d;
  return copy;
}

/** Preserve every unknown row and field. A null student selects the shared library. */
export function changeShelf(state: LockerState, studentId: string | null, update: (rows: unknown[]) => unknown[], attachment?: [string, ShelfAsset]): LockerState {
  const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const assets = attachment ? { assets: { ...(state.assets as object | undefined), [attachment[0]]: attachment[1] } } : {};
  if (!studentId) return { ...state, ...assets, shelfLibrary: update(rows(state.shelfLibrary)) };
  return { ...state, ...assets, students: (state.students ?? []).map((student: LockerStudent) =>
    student?.id === studentId ? { ...student, shelf: update(rows(student.shelf)) } : student) };
}

export const hasShelfId = (row: unknown, id: string) => !!row && typeof row === "object" && "id" in row && row.id === id;
