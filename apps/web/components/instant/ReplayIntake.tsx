"use client";

import { useDropTarget } from "./useDropTarget";
import { useReplayAccept } from "./useReplayAccept";
import { filesOf } from "./replayDropFiles";
export { useReplayAccept } from "./useReplayAccept";
export { collectDroppedFiles } from "./replayDropFiles";

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
 * `onIntent` fires on the visitor's first signs of adding replays — a
 * pointer or key press on a "Choose…" button, files dragged over the drop
 * zone, focus moving into the panel — so the caller can warm the analyzer
 * up (`session.prewarm`) while the file dialog is still open. It never
 * fires on mount.
 *
 * Example:
 *   <ReplayIntake onFiles={session.addFiles} dateWindow={session.dateWindow}
 *     onDateWindowChange={session.setDateWindow} fileCount={session.files.length}
 *     estimate={session.estimate} maxFiles={MAX_TRY_FILES} disabled={session.busy} allowFolderInput />
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ChangeEvent,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { FileUp, FolderOpen, FolderSync, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { type DateWindow, type ParseEstimate } from "@/lib/instant/fileIntake";
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
  /** The visitor is about to add replays (see module comment); may fire often. */
  onIntent?: () => void;
  /**
   * Bump to move keyboard focus onto the panel's heading (e.g. after the
   * control that had focus disappeared); 0 leaves focus alone. Focusing
   * the heading is not treated as intent.
   */
  focusKey?: number;
  className?: string;
}

function IntakeStatus({ fileCount, estimate, maxFiles }: Pick<ReplayIntakeProps, "fileCount" | "estimate" | "maxFiles">) {
  const noun = fileCount === 1 ? "replay" : "replays";
  const timing = estimate ? ` · ${estimate.label} to analyze` : "";
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
  onIntent?: () => void;
}

function IntakeButtons({ disabled, hintsId, onChooseFiles, onChooseFolder, onPickFolder, onIntent }: IntakeButtonsProps) {
  // Pressing a "Choose…" button is the earliest sign of a run: warm up before the dialog opens.
  const intent = { onPointerDown: onIntent, onKeyDown: onIntent };
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button onClick={onChooseFiles} {...intent} disabled={disabled} aria-describedby={hintsId} iconLeft={<FileUp className="h-4 w-4" aria-hidden />}>
        Choose replays
      </Button>
      {onChooseFolder ? (
        <Button variant="secondary" onClick={onChooseFolder} {...intent} disabled={disabled} aria-describedby={hintsId} iconLeft={<FolderOpen className="h-4 w-4" aria-hidden />}>
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
  headingRef: RefObject<HTMLParagraphElement | null>;
  hintsId: string;
  onDropFiles: (files: File[]) => void;
  onIntent?: () => void;
  children: ReactNode;
}

function DropZone({ disabled, headingId, headingRef, hintsId, onDropFiles, onIntent, children }: DropZoneProps) {
  const { dragging, reading, handlers } = useDropTarget(disabled, onDropFiles, onIntent);
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
      <p id={headingId} ref={headingRef} tabIndex={-1} className="font-display text-h4 text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Add your replays
      </p>
      <p id={hintsId} className="max-w-prose text-caption text-text-muted">
        Drag .SC2Replay files, a replay folder or a .zip of them here, or choose them. Replays are analyzed right here in
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

/** Focus the heading whenever `focusKey` is bumped (never for 0). */
function useHeadingFocus(focusKey: number): RefObject<HTMLParagraphElement | null> {
  const heading = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (focusKey > 0) heading.current?.focus();
  }, [focusKey]);
  return heading;
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
  onIntent,
  focusKey = 0,
  className = "",
}: ReplayIntakeProps) {
  const headingId = useId();
  const hintsId = useId();
  const accept = useReplayAccept();
  const inputs = usePickerInputs(onFiles);
  const heading = useHeadingFocus(focusKey);
  const intent = disabled ? undefined : onIntent;
  const onFocus = (event: FocusEvent<HTMLElement>): void => {
    if (event.target !== heading.current) intent?.();
  };
  return (
    <section aria-labelledby={headingId} onFocus={onFocus} className={["space-y-4", className].filter(Boolean).join(" ")}>
      <DropZone
        disabled={disabled}
        headingId={headingId}
        headingRef={heading}
        hintsId={hintsId}
        onDropFiles={(files) => onFiles(files, "drop")}
        onIntent={intent}
      >
        <div className="flex w-full min-w-0 flex-wrap items-end justify-center gap-3 text-caption text-text-muted">
          <DateWindowSelect value={dateWindow} onChange={onDateWindowChange} disabled={disabled} />
          <div className="pb-1"><p>Applies to the replays you add next</p>{maxFiles !== undefined ? <p>newest {maxFiles} replays</p> : null}</div>
        </div>
        <IntakeButtons
          disabled={disabled}
          hintsId={hintsId}
          onChooseFiles={() => inputs.fileInput.current?.click()}
          onChooseFolder={allowFolderInput ? () => inputs.folderInput.current?.click() : undefined}
          onPickFolder={onPickFolder}
          onIntent={intent}
        />
      </DropZone>
      <input ref={inputs.fileInput} type="file" multiple accept={accept} onChange={inputs.onPicked("picker")} disabled={disabled} tabIndex={-1} aria-label="Replay files" className="sr-only" />
      {allowFolderInput ? (
        <input ref={inputs.attachFolderInput} type="file" multiple onChange={inputs.onPicked("folder")} disabled={disabled} tabIndex={-1} aria-label="Replay folder" className="sr-only" />
      ) : null}
      <IntakeStatus fileCount={fileCount} estimate={estimate} maxFiles={maxFiles} />
      <details className="rounded-lg border-2 border-line bg-bg-surface px-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Where are my replays?
        </summary>
        <OsPathHints className="pb-3" folderPicking={allowFolderInput || Boolean(onPickFolder)} />
      </details>
    </section>
  );
}
