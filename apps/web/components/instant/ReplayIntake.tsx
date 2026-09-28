"use client";

/**
 * ReplayIntake — where a visitor hands us replays: a drag-and-drop zone
 * (files, .zip archives or whole folders, walked with `webkitGetAsEntry`
 * so the toon folder still identifies the player), a keyboard-accessible
 * "Choose replays" button (multi-select, .zip accepted), an optional
 * folder input for browsers without Folder Sync
 * (`<input webkitdirectory>`, Firefox/Safari), an optional caller-provided
 * Folder Sync button (Chromium), the date window, a file count + time
 * estimate, and where-are-my-replays hints.
 *
 * Every picked or dropped file is forwarded as-is: the caller
 * (`useInstantSession.addFiles`) owns filtering, so non-replays are ignored
 * there. On iOS/iPadOS the picker gets no `accept` filter, because Files
 * greys out `.SC2Replay` (no UTI for the extension).
 *
 * Example:
 *   <ReplayIntake onFiles={session.addFiles} dateWindow={session.dateWindow}
 *     onDateWindowChange={session.setDateWindow} fileCount={session.files.length}
 *     estimate={session.estimate} maxFiles={MAX_TRY_FILES} disabled={session.busy} allowFolderInput />
 */
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { FileUp, FolderOpen, FolderSync, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui";
import { REPLAY_INPUT_ACCEPT, replayInputAccept, type DateWindow, type ParseEstimate } from "@/lib/instant/fileIntake";
import type { IntakeSource } from "@/lib/instant/types";
import { DateWindowSelect } from "./DateWindowSelect";
import { OsPathHints } from "./OsPathHints";

export interface ReplayIntakeProps {
  /** Every picked/dropped file; the caller filters by extension. */
  onFiles: (files: File[], source: IntakeSource) => void;
  /** Chromium Folder Sync (File System Access API), shown when provided. */
  onPickFolder?: () => void;
  disabled?: boolean;
  /** Per-run cap, mentioned in the microcopy. */
  maxFiles?: number;
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  /** Replays currently queued. */
  fileCount: number;
  estimate?: ParseEstimate | null;
  /** Show the `<input webkitdirectory>` folder picker (Firefox/Safari). */
  allowFolderInput?: boolean;
  className?: string;
}

/**
 * Stop walking a dropped folder tree after this many files, so dropping a
 * whole drive by mistake cannot run away. A full Accounts folder is far below.
 */
const MAX_DROPPED_FILES = 50_000;

function filesOf(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

/**
 * The drop's entries when it contains a folder, else null (plain files use
 * `dataTransfer.files`). Read synchronously: items expire after the event.
 */
function droppedTreeRoots(transfer: DataTransfer | null | undefined): FileSystemEntry[] | null {
  const items = transfer?.items ? Array.from(transfer.items) : [];
  const roots = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  return roots.some(isDirectoryEntry) ? roots : null;
}

async function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const entries: FileSystemEntry[] = [];
  // readEntries returns at most ~100 entries per call; an empty batch ends the listing.
  for (let batch = await readBatch(); batch.length > 0; batch = await readBatch()) entries.push(...batch);
  return entries;
}

/**
 * A dropped file carries no folder path. Give it the one a folder picker
 * would, so `makeIntakeFile` sees the toon folder (`1-S2-1-267727`) and the
 * player is identified exactly, like the desktop agent.
 */
function withDroppedPath(file: File, fullPath: string): File {
  const relativePath = fullPath.replace(/^\/+/, "");
  // `webkitRelativePath` is a read-only prototype getter; an own property
  // shadows it without copying the file's bytes.
  if (relativePath) Object.defineProperty(file, "webkitRelativePath", { value: relativePath, configurable: true });
  return file;
}

/** The entry's file with its folder path, or null when it cannot be read (broken link, revoked access). */
function readFileEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject)).then(
    (file) => withDroppedPath(file, entry.fullPath),
    () => null,
  );
}

/** A directory's children, or none when it cannot be listed. */
function readChildren(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return readDirectory(directory).catch(() => []);
}

/**
 * Every file under the dropped entries, each carrying its folder path as
 * `webkitRelativePath`. Walks one folder level at a time and resolves each
 * level in parallel (one `entry.file()` round-trip per file would crawl on
 * a large Accounts folder). Unreadable entries are skipped; never rejects.
 *
 * Example:
 *   const files = await collectDroppedFiles([item.webkitGetAsEntry()]);
 *   files[0].webkitRelativePath; // -> "Accounts/1/1-S2-1-267727/Replays/Multiplayer/a.SC2Replay"
 */
export async function collectDroppedFiles(roots: ReadonlyArray<FileSystemEntry>): Promise<File[]> {
  const files: File[] = [];
  let level: FileSystemEntry[] = [...roots];
  while (level.length > 0 && files.length < MAX_DROPPED_FILES) {
    const read = await Promise.all(level.filter(isFileEntry).map(readFileEntry));
    files.push(...read.filter((file): file is File => file !== null));
    level = (await Promise.all(level.filter(isDirectoryEntry).map(readChildren))).flat();
  }
  return files.slice(0, MAX_DROPPED_FILES);
}

/** `accept` for the picker, decided after mount (navigator is client-only). */
function useReplayAccept(): string | undefined {
  const [accept, setAccept] = useState<string | undefined>(REPLAY_INPUT_ACCEPT);
  useEffect(() => {
    setAccept(replayInputAccept(navigator.userAgent, navigator.maxTouchPoints));
  }, []);
  return accept;
}

/** Forward a dropped folder tree once it has been walked (see `collectDroppedFiles`). */
function useFolderDrop(onDropFiles: (files: File[]) => void) {
  const [reading, setReading] = useState(false);
  const readTree = (roots: FileSystemEntry[]): void => {
    setReading(true);
    void collectDroppedFiles(roots).then((files) => {
      setReading(false);
      if (files.length > 0) onDropFiles(files);
    });
  };
  return { reading, readTree };
}

/** Drop handlers; a depth counter keeps child elements from flickering the highlight. */
function useDropTarget(disabled: boolean, onDropFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const { reading, readTree } = useFolderDrop(onDropFiles);
  const handlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const roots = droppedTreeRoots(event.dataTransfer);
      if (roots) {
        readTree(roots);
        return;
      }
      const files = filesOf(event.dataTransfer?.files);
      if (files.length > 0) onDropFiles(files);
    },
  };
  return { dragging, reading, handlers };
}

function IntakeStatus({ fileCount, estimate, maxFiles }: Pick<ReplayIntakeProps, "fileCount" | "estimate" | "maxFiles">) {
  const noun = fileCount === 1 ? "replay" : "replays";
  const timing = estimate ? ` · ${estimate.label} to analyse` : "";
  return (
    <div className="space-y-0.5 text-caption text-text-muted">
      <p role="status" aria-live="polite" className="font-semibold text-text">
        {fileCount === 0 ? "No replays selected yet." : `${fileCount} ${noun} ready${timing}`}
      </p>
      {maxFiles !== undefined ? <p>Up to {maxFiles} replays per run — we keep the most recent ones.</p> : null}
    </div>
  );
}

interface IntakeButtonsProps {
  disabled: boolean;
  hintsId: string;
  onChooseFiles: () => void;
  onChooseFolder?: () => void;
  onPickFolder?: () => void;
}

function IntakeButtons({ disabled, hintsId, onChooseFiles, onChooseFolder, onPickFolder }: IntakeButtonsProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button onClick={onChooseFiles} disabled={disabled} aria-describedby={hintsId} iconLeft={<FileUp className="h-4 w-4" aria-hidden />}>
        Choose replays
      </Button>
      {onChooseFolder ? (
        <Button variant="secondary" onClick={onChooseFolder} disabled={disabled} aria-describedby={hintsId} iconLeft={<FolderOpen className="h-4 w-4" aria-hidden />}>
          Choose a folder
        </Button>
      ) : null}
      {onPickFolder ? (
        <Button variant="secondary" onClick={onPickFolder} disabled={disabled} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
          Sync a replay folder
        </Button>
      ) : null}
    </div>
  );
}

interface DropZoneProps {
  disabled: boolean;
  headingId: string;
  hintsId: string;
  onDropFiles: (files: File[]) => void;
  children: ReactNode;
}

function DropZone({ disabled, headingId, hintsId, onDropFiles, children }: DropZoneProps) {
  const { dragging, reading, handlers } = useDropTarget(disabled, onDropFiles);
  return (
    <div
      {...handlers}
      data-dragging={dragging || undefined}
      className={[
        "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center",
        "transition-colors motion-reduce:transition-none",
        dragging ? "border-accent bg-accent/10" : "border-line bg-bg-elevated/60",
        disabled ? "opacity-60" : "",
      ].filter(Boolean).join(" ")}
    >
      <UploadCloud className={["h-8 w-8", dragging ? "text-accent" : "text-text-muted"].join(" ")} aria-hidden />
      <p id={headingId} className="font-display text-h4 text-text">Add your replays</p>
      <p id={hintsId} className="max-w-prose text-caption text-text-muted">
        Drag .SC2Replay files, a replay folder or a .zip of them here, or choose them. Replays are analysed right here in
        your browser.
      </p>
      {children}
      {reading ? (
        <p role="status" className="text-caption font-semibold text-text">
          Reading the dropped folder…
        </p>
      ) : null}
    </div>
  );
}

/** Refs + change handler for the hidden file and folder inputs. */
function usePickerInputs(onFiles: ReplayIntakeProps["onFiles"]) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  // `webkitdirectory` is non-standard and missing from React's input types.
  const attachFolderInput = useCallback((node: HTMLInputElement | null) => {
    folderInput.current = node;
    node?.setAttribute("webkitdirectory", "");
  }, []);
  const onPicked = (source: IntakeSource) => (event: ChangeEvent<HTMLInputElement>) => {
    const files = filesOf(event.currentTarget.files);
    event.currentTarget.value = "";
    if (files.length > 0) onFiles(files, source);
  };
  return { fileInput, folderInput, attachFolderInput, onPicked };
}

/**
 * The replay intake panel (see module comment).
 *
 * Example:
 *   <ReplayIntake onFiles={(files, source) => void session.addFiles(files, source)} ... />
 */
export function ReplayIntake({
  onFiles,
  onPickFolder,
  disabled = false,
  maxFiles,
  dateWindow,
  onDateWindowChange,
  fileCount,
  estimate = null,
  allowFolderInput = false,
  className = "",
}: ReplayIntakeProps) {
  const headingId = useId();
  const hintsId = useId();
  const accept = useReplayAccept();
  const inputs = usePickerInputs(onFiles);
  return (
    <section aria-labelledby={headingId} className={["space-y-4", className].filter(Boolean).join(" ")}>
      <DropZone disabled={disabled} headingId={headingId} hintsId={hintsId} onDropFiles={(files) => onFiles(files, "drop")}>
        <IntakeButtons
          disabled={disabled}
          hintsId={hintsId}
          onChooseFiles={() => inputs.fileInput.current?.click()}
          onChooseFolder={allowFolderInput ? () => inputs.folderInput.current?.click() : undefined}
          onPickFolder={onPickFolder}
        />
      </DropZone>
      <input ref={inputs.fileInput} type="file" multiple accept={accept} onChange={inputs.onPicked("picker")} disabled={disabled} tabIndex={-1} aria-label="Replay files" className="sr-only" />
      {allowFolderInput ? (
        <input ref={inputs.attachFolderInput} type="file" multiple onChange={inputs.onPicked("folder")} disabled={disabled} tabIndex={-1} aria-label="Replay folder" className="sr-only" />
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <DateWindowSelect value={dateWindow} onChange={onDateWindowChange} disabled={disabled} />
        <IntakeStatus fileCount={fileCount} estimate={estimate} maxFiles={maxFiles} />
      </div>
      <details className="rounded-lg border-2 border-line bg-bg-surface px-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Where are my replays?
        </summary>
        <OsPathHints className="pb-3" folderPicking={allowFolderInput || Boolean(onPickFolder)} />
      </details>
    </section>
  );
}
