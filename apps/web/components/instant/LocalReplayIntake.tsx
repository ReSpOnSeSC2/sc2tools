"use client";

import { useRef, type DragEvent } from "react";
import { FolderOpen, Upload } from "lucide-react";
import { collectDroppedFiles, droppedTreeRoots, filesOf, MAX_DROPPED_FILES } from "@/components/instant/replayDropFiles";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { isReplayFileName, makeIntakeFile } from "@/lib/instant/fileIntake";
import { pickReplaysFolder, supportsDirectoryPicker, walkReplayFolder } from "@/lib/instant/folderSync";
import type { IntakeFile, IntakeSource, ReplaySource } from "@/lib/instant/types";

type ModifiedWindow = { since: Date; until: Date };

function intakeFiles(files: File[], source: IntakeSource): IntakeFile[] {
  return files.filter((file) => isReplayFileName(file.name)).slice(0, MAX_DROPPED_FILES)
    .map((file) => makeIntakeFile(file, source));
}

async function readFolder(signal: AbortSignal, modifiedWindow?: ModifiedWindow) {
  const folder = await pickReplaysFolder();
  if (!folder) return null;
  const found = await walkReplayFolder(folder, { signal, maxFiles: MAX_DROPPED_FILES, keepSnapshots: true });
  const files: IntakeFile[] = [];
  for (const entry of found) {
    signal.throwIfAborted();
    if (modifiedWindow && (entry.lastModified < modifiedWindow.since.getTime()
      || entry.lastModified > modifiedWindow.until.getTime())) continue;
    files.push(makeIntakeFile(await entry.getFile(), "folder", entry.relativePath));
  }
  return files;
}

export function LocalReplayIntake({ start, modifiedWindow, disabled = false }: {
  start: (source: ReplaySource) => Promise<void>;
  modifiedWindow?: ModifiedWindow;
  disabled?: boolean;
}) {
  const folderInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (disabled) return;
    const roots = droppedTreeRoots(event.dataTransfer);
    const flat = roots ? [] : filesOf(event.dataTransfer.files);
    void start(async (signal) => intakeFiles(roots ? await collectDroppedFiles(roots, signal) : flat, "drop"));
  }

  function picked(input: HTMLInputElement, source: IntakeSource) {
    const files = filesOf(input.files);
    input.value = "";
    if (files.length) void start(async () => intakeFiles(files, source));
  }

  return (
    <Card padded={false} aria-labelledby="local-replay-intake" className="space-y-4 border-dashed p-5 sm:p-7"
      onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <div className="space-y-1">
        <h2 id="local-replay-intake" data-recap-heading="" tabIndex={-1}
          className="rounded-sm text-h3 font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Choose your replays
        </h2>
        <p className="text-body text-text-muted">Drop your StarCraft II folder here or choose a folder below.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" className="min-h-11" disabled={disabled} iconLeft={<FolderOpen className="size-4" aria-hidden />}
          onClick={() => supportsDirectoryPicker()
            ? void start((signal) => readFolder(signal, modifiedWindow))
            : folderInput.current?.click()}>
          Choose a folder
        </Button>
        <Button variant="secondary" className="min-h-11" disabled={disabled} iconLeft={<Upload className="size-4" aria-hidden />}
          onClick={() => fileInput.current?.click()}>
          Choose replay files
        </Button>
      </div>
      <input ref={fileInput} type="file" multiple hidden aria-label="Replay files" accept=".SC2Replay"
        onChange={(event) => picked(event.currentTarget, "picker")} />
      <input ref={(element) => {
        folderInput.current = element;
        element?.setAttribute("webkitdirectory", "");
      }} type="file" multiple hidden aria-label="Replay folder" onChange={(event) => picked(event.currentTarget, "folder")} />
      <p className="text-caption text-text-muted">Your browser may call folder selection an upload. Your replays stay on this device.</p>
    </Card>
  );
}
