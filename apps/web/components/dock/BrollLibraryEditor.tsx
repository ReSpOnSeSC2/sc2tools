"use client";

import { useState } from "react";
import type {
  StudioBrollClip,
  StudioBrollConfig,
} from "@/lib/multichat/useStudioState";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CLIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_IMPORT_CLIPS = 100;
const MAX_TIMESTAMP_SECONDS = 86_400;
const MAX_TITLE_LENGTH = 120;

/** Accept a bare video ID or the common YouTube watch/share/live URL shapes. */
export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (VIDEO_ID_RE.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let candidate = "";
  if (hostname === "youtu.be") {
    candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtube-nocookie.com" ||
    hostname.endsWith(".youtube-nocookie.com")
  ) {
    candidate = parsed.searchParams.get("v") ?? "";
    if (!candidate) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["embed", "live", "shorts", "v", "video"].includes(parts[0] ?? "")) {
        candidate = parts[1] ?? "";
      }
    }
  }

  return VIDEO_ID_RE.test(candidate) ? candidate : null;
}

/** Parse seconds, mm:ss, or hh:mm:ss into a whole non-negative second. */
export function parseBrollTimecode(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Math.floor(Number(value));
    return Number.isSafeInteger(seconds) &&
      seconds >= 0 &&
      seconds <= MAX_TIMESTAMP_SECONDS
      ? seconds
      : null;
  }

  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) return null;
  if (!parts.slice(0, -1).every((part) => /^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.at(-1) ?? 0;
  const minutes = numbers.at(-2) ?? 0;
  const hours = numbers.length === 3 ? numbers[0] : 0;
  if (seconds >= 60 || minutes >= 60 || !Number.isInteger(hours)) return null;
  const total = Math.floor(hours * 3600 + minutes * 60 + seconds);
  return Number.isSafeInteger(total) &&
    total >= 0 &&
    total <= MAX_TIMESTAMP_SECONDS
    ? total
    : null;
}

function formatTimecode(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stableClipId(
  videoId: string,
  startSeconds: number,
  endSeconds: number,
  usedIds: Set<string>,
): string {
  const base = `${videoId}-${startSeconds}-${endSeconds}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export type BrollLibraryParseResult =
  | { clips: StudioBrollClip[]; error: null }
  | { clips: null; error: string };

/**
 * Import the editor's versioned object, a full b-roll object, or a bare clips
 * array. Settings are deliberately not imported so live audio/order choices
 * cannot be changed by a library file.
 */
export function parseBrollLibraryJson(input: string): BrollLibraryParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { clips: null, error: "That is not valid JSON." };
  }

  let rawClips: unknown = parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>;
    const nested = object.broll;
    rawClips =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Record<string, unknown>).clips
        : object.clips;
  }
  if (!Array.isArray(rawClips)) {
    return { clips: null, error: "JSON must contain a clips array." };
  }
  if (rawClips.length > MAX_IMPORT_CLIPS) {
    return {
      clips: null,
      error: `A library can contain at most ${MAX_IMPORT_CLIPS} clips.`,
    };
  }

  const clips: StudioBrollClip[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < rawClips.length; index += 1) {
    const raw = rawClips[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { clips: null, error: `Clip ${index + 1} is not an object.` };
    }
    const clip = raw as Record<string, unknown>;
    const videoId = parseYouTubeVideoId(String(clip.videoId ?? ""));
    const startSeconds = Number(clip.startSeconds);
    const endSeconds = Number(clip.endSeconds);
    if (!videoId) {
      return { clips: null, error: `Clip ${index + 1} has an invalid YouTube ID.` };
    }
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      startSeconds > MAX_TIMESTAMP_SECONDS ||
      endSeconds > MAX_TIMESTAMP_SECONDS ||
      endSeconds <= startSeconds
    ) {
      return { clips: null, error: `Clip ${index + 1} has an invalid time range.` };
    }

    const start = Math.floor(startSeconds);
    const end = Math.floor(endSeconds);
    if (end <= start) {
      return { clips: null, error: `Clip ${index + 1} has an invalid time range.` };
    }
    const requestedId = typeof clip.id === "string" ? clip.id.trim() : "";
    const id =
      CLIP_ID_RE.test(requestedId) && !usedIds.has(requestedId)
        ? requestedId
        : stableClipId(videoId, start, end, usedIds);
    usedIds.add(id);
    let vertical: StudioBrollClip["vertical"];
    if (Object.hasOwn(clip, "vertical")) {
      const rawVertical = clip.vertical;
      if (
        !rawVertical ||
        typeof rawVertical !== "object" ||
        Array.isArray(rawVertical)
      ) {
        return {
          clips: null,
          error: `Clip ${index + 1} has an invalid vertical source.`,
        };
      }
      const source = rawVertical as Record<string, unknown>;
      const verticalVideoId = parseYouTubeVideoId(String(source.videoId ?? ""));
      const verticalStartRaw = source.startSeconds;
      if (
        !verticalVideoId ||
        typeof verticalStartRaw !== "number" ||
        !Number.isFinite(verticalStartRaw)
      ) {
        return {
          clips: null,
          error: `Clip ${index + 1} has an invalid vertical source.`,
        };
      }
      const verticalStartSeconds = Math.floor(verticalStartRaw);
      if (
        verticalStartSeconds < 0 ||
        verticalStartSeconds + (end - start) > MAX_TIMESTAMP_SECONDS
      ) {
        return {
          clips: null,
          error: `Clip ${index + 1} has an invalid vertical time range.`,
        };
      }
      vertical = {
        videoId: verticalVideoId,
        startSeconds: verticalStartSeconds,
      };
    }
    clips.push({
      id,
      title:
        typeof clip.title === "string" && clip.title.trim()
          ? clip.title.trim().slice(0, MAX_TITLE_LENGTH)
          : `Highlight ${index + 1}`,
      videoId,
      startSeconds: start,
      endSeconds: end,
      ...(vertical ? { vertical } : {}),
    });
  }
  return { clips, error: null };
}

function libraryJson(clips: StudioBrollClip[]): string {
  return JSON.stringify({ version: 1, clips }, null, 2);
}

export function BrollLibraryEditor({
  broll,
  busy,
  onPost,
}: {
  broll: StudioBrollConfig;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("0:00");
  const [end, setEnd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [transferStatus, setTransferStatus] = useState<string | null>(null);
  const [transferError, setTransferError] = useState(false);

  const saveClips = (clips: StudioBrollClip[]) =>
    onPost({ broll: { clips } });

  const addClip = async () => {
    const videoId = parseYouTubeVideoId(source);
    const startSeconds = parseBrollTimecode(start);
    const endSeconds = parseBrollTimecode(end);
    if (!videoId) {
      setFormError("Paste a valid YouTube URL or 11-character video ID.");
      return;
    }
    if (startSeconds === null || endSeconds === null) {
      setFormError("Enter start and end as seconds, mm:ss, or hh:mm:ss.");
      return;
    }
    if (endSeconds <= startSeconds) {
      setFormError("End time must be later than start time.");
      return;
    }
    if (broll.clips.length >= MAX_IMPORT_CLIPS) {
      setFormError(`A library can contain at most ${MAX_IMPORT_CLIPS} clips.`);
      return;
    }

    const usedIds = new Set(broll.clips.map((clip) => clip.id));
    const clip: StudioBrollClip = {
      id: stableClipId(videoId, startSeconds, endSeconds, usedIds),
      title:
        title.trim().slice(0, MAX_TITLE_LENGTH) ||
        `Highlight ${broll.clips.length + 1}`,
      videoId,
      startSeconds,
      endSeconds,
    };
    setFormError(null);
    await saveClips([...broll.clips, clip]);
    // Keep the VOD in place and roll the previous end forward. Cutting several
    // moments from one stream then only needs a title and new end time.
    setTitle("");
    setStart(formatTimecode(endSeconds));
    setEnd("");
  };

  const exportJson = async () => {
    const json = libraryJson(broll.clips);
    setJsonDraft(json);
    try {
      await navigator.clipboard.writeText(json);
      setTransferError(false);
      setTransferStatus("Library JSON copied.");
    } catch {
      setTransferError(false);
      setTransferStatus("Library JSON is ready below — copy it manually.");
    }
  };

  const importLibraryJson = async (input: string) => {
    const parsed = parseBrollLibraryJson(input);
    if (parsed.clips === null) {
      setTransferError(true);
      setTransferStatus(parsed.error);
      return;
    }
    await saveClips(parsed.clips);
    setTransferError(false);
    setTransferStatus(
      `Imported ${parsed.clips.length} ${parsed.clips.length === 1 ? "clip" : "clips"}.`,
    );
  };

  const importJsonFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".json")) {
      setTransferError(true);
      setTransferStatus("Choose a .json library file.");
      return;
    }

    try {
      const contents = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
        reader.onload = () =>
          resolve(typeof reader.result === "string" ? reader.result : "");
        reader.readAsText(file);
      });
      setJsonDraft(contents);
      await importLibraryJson(contents);
    } catch {
      setTransferError(true);
      setTransferStatus("Could not read that JSON file.");
    }
  };

  return (
    <details className="mt-2 border-t border-border pt-2">
      <summary className="cursor-pointer select-none text-caption font-medium text-text hover:text-accent-cyan">
        Manage highlight library
      </summary>

      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          <input
            type="text"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="YouTube URL or video ID"
            aria-label="YouTube URL or video ID"
            className="col-span-2 min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none sm:col-span-1"
          />
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`Title (Highlight ${broll.clips.length + 1})`}
            aria-label="B-roll clip title"
            maxLength={MAX_TITLE_LENGTH}
            className="col-span-2 min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none sm:col-span-1"
          />
          <label className="flex items-center gap-1 text-caption text-text-dim">
            Start
            <input
              type="text"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder="0:00"
              aria-label="B-roll start time"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-elevated px-2 py-1 tabular-nums text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-1 text-caption text-text-dim">
            End
            <input
              type="text"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              placeholder="1:30"
              aria-label="B-roll end time"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-elevated px-2 py-1 tabular-nums text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void addClip()}
            className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-caption font-medium text-text transition-colors hover:border-accent disabled:opacity-50"
          >
            + Add highlight
          </button>
          <span className="text-micro text-text-dim">
            Tip: after adding, the end time becomes the next start time.
          </span>
        </div>
        {formError ? (
          <p role="alert" className="text-caption text-danger">
            {formError}
          </p>
        ) : null}

        {broll.clips.length > 0 ? (
          <ol className="max-h-52 space-y-1 overflow-y-auto" aria-label="B-roll clips">
            {broll.clips.map((clip, index) => (
              <li
                key={clip.id}
                className="flex items-center gap-2 rounded border border-border/70 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption text-text">
                    {index + 1}. {clip.title}
                  </span>
                  <span className="block truncate text-micro tabular-nums text-text-dim">
                    {formatTimecode(clip.startSeconds)}–{formatTimecode(clip.endSeconds)}
                    {" · "}
                    {formatTimecode(clip.endSeconds - clip.startSeconds)} long
                    {clip.vertical ? " · Vertical paired" : " · Horizontal only"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${clip.title}`}
                  onClick={() =>
                    void saveClips(
                      broll.clips.filter((candidate) => candidate.id !== clip.id),
                    )
                  }
                  className="rounded border border-danger/40 px-2 py-1 text-micro text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        ) : null}

        <details className="rounded border border-border/70 p-2">
          <summary className="cursor-pointer select-none text-caption text-text-muted hover:text-text">
            Import / export JSON
          </summary>
          <div className="mt-2 space-y-1.5">
            <textarea
              value={jsonDraft}
              onChange={(event) => setJsonDraft(event.target.value)}
              placeholder="Paste a library JSON file here"
              aria-label="B-roll library JSON"
              rows={5}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-border bg-bg-elevated px-2 py-1 font-mono text-micro text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <label className="block text-micro text-text-dim">
              Import a .json library file
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Import b-roll library JSON file"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void importJsonFile(file);
                  event.currentTarget.value = "";
                }}
                className="mt-1 block w-full rounded-md border border-border bg-bg-elevated text-micro text-text file:mr-2 file:border-0 file:border-r file:border-border file:bg-transparent file:px-2 file:py-1 file:text-caption file:text-text-muted disabled:opacity-50"
              />
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => void exportJson()}
                className="rounded border border-border px-2 py-1 text-caption text-text-muted hover:border-accent hover:text-text"
              >
                Copy current JSON
              </button>
              <button
                type="button"
                disabled={busy || !jsonDraft.trim()}
                onClick={() => void importLibraryJson(jsonDraft)}
                className="rounded border border-border px-2 py-1 text-caption text-text-muted hover:border-accent hover:text-text disabled:opacity-50"
              >
                Replace library from JSON
              </button>
            </div>
            {transferStatus ? (
              <p
                role={transferError ? "alert" : "status"}
                className={`text-micro ${transferError ? "text-danger" : "text-text-dim"}`}
              >
                {transferStatus}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </details>
  );
}
