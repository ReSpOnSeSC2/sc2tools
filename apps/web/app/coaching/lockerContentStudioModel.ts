import type { StudioKind } from "./LockerStudioGuides";
import type { ShelfReplayContext } from "./lockerStudioReplays";

export const STUDIO_TITLES = {
  notes: "Session notes", voice: "Voice memo", video: "Video", image: "Annotated screenshot", replay: "Replay + note", pdf: "PDF practice card",
} as const;

const MIB = 1024 * 1024;
export const STUDIO_FILE_LIMITS: Partial<Record<StudioKind, number>> = { voice: 2.5 * MIB, video: 6 * MIB, image: 6 * MIB, replay: 900 * 1024, pdf: 4 * MIB };
export const STUDIO_FILE_TYPES: Partial<Record<StudioKind, string>> = { voice: "audio/*", video: "video/mp4,video/webm", replay: ".SC2Replay", pdf: "application/pdf,.pdf" };

export type StudioDraft = { kind: StudioKind; title: string; notes: string; link: string; file?: File; replay?: ShelfReplayContext };

function secureLink(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (text.length > 2048 || /[\\\p{Cc}\p{Cf}]/u.test(text)) throw new Error("Enter an HTTPS link without embedded credentials.");
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Enter a complete HTTPS link."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Enter an HTTPS link without embedded credentials.");
  return url.href;
}

export async function validateStudioDraft(draft: StudioDraft): Promise<StudioDraft> {
  const { kind, file, replay } = draft;
  const title = draft.title.trim().slice(0, 180) || STUDIO_TITLES[kind];
  const notes = draft.notes.trim().slice(0, 5000);
  const link = secureLink(draft.link);
  if (link && kind !== "video" && kind !== "replay") throw new Error("Choose an attachment for this item.");
  if (file && (link || replay)) throw new Error("Choose an attached file or a linked replay or video.");
  if (kind === "notes" && !notes) throw new Error("Add a note or insert a structure before saving.");
  if (kind !== "notes" && !file && !link && !replay) throw new Error("Choose a file, record audio, or link the item before saving.");
  if (file) {
    const limit = STUDIO_FILE_LIMITS[kind];
    if (!limit || !file.size || file.size > limit) throw new Error(kind === "replay" ? "Choose a replay file up to 900 KiB." : `Choose a file up to ${limit ? limit / MIB : 0} MiB.`);
    if (kind === "pdf" && !(await pdfHeader(file))) throw new Error("Choose a valid PDF file.");
    if (kind === "replay" && !/\.sc2replay$/i.test(file.name)) throw new Error("Choose a StarCraft II .SC2Replay file.");
    if (kind === "video" && !/^video\/(?:mp4|webm)$/i.test(file.type)) throw new Error("Choose an MP4 or WebM video.");
  }
  return { kind, title, notes, link, ...(file ? { file } : {}), ...(replay ? { replay } : {}) };
}

function pdfHeader(file: File): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The PDF could not be read."));
    reader.onload = () => resolve(/^%PDF-\d\.\d\b/.test(String(reader.result)));
    reader.readAsText(file.slice(0, 16));
  });
}

export function studioAnnotatedFile(data: string): File {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[1].length > 8 * MIB) throw new Error("The annotated screenshot could not be saved.");
  const bytes = Uint8Array.from(atob(match[1]), character => character.charCodeAt(0));
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || !bytes.length || bytes.length > STUDIO_FILE_LIMITS.image!) throw new Error("The annotated screenshot could not be saved.");
  return new File([bytes], "annotated-screenshot.jpg", { type: "image/jpeg" });
}
