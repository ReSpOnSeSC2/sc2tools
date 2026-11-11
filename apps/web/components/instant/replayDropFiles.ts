/**
 * Stop walking a dropped folder tree after this many files, so dropping a
 * whole drive by mistake cannot run away. A full Accounts folder is far below.
 */
export const MAX_DROPPED_FILES = 50_000;
const FILE_READ_BATCH_SIZE = 32;

export function filesOf(list: FileList | null | undefined): File[] {
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
export function droppedTreeRoots(transfer: DataTransfer | null | undefined): FileSystemEntry[] | null {
  const items = transfer?.items ? Array.from(transfer.items) : [];
  const roots = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  return roots.some(isDirectoryEntry) ? roots : null;
}

async function readDirectory(directory: FileSystemDirectoryEntry, signal?: AbortSignal): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const entries: FileSystemEntry[] = [];
  // readEntries returns at most ~100 entries per call; an empty batch ends the listing.
  for (;;) {
    signal?.throwIfAborted();
    const batch = await readBatch();
    signal?.throwIfAborted();
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
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
function readChildren(directory: FileSystemDirectoryEntry, signal?: AbortSignal): Promise<FileSystemEntry[]> {
  return readDirectory(directory, signal).catch(() => {
    signal?.throwIfAborted();
    return [];
  });
}

async function appendFiles(entries: FileSystemFileEntry[], files: File[], signal?: AbortSignal): Promise<void> {
  for (let index = 0; index < entries.length && files.length < MAX_DROPPED_FILES; index += FILE_READ_BATCH_SIZE) {
    signal?.throwIfAborted();
    const read = await Promise.all(entries.slice(index, index + FILE_READ_BATCH_SIZE).map(readFileEntry));
    signal?.throwIfAborted();
    files.push(...read.filter((file): file is File => file !== null));
  }
}

/**
 * Every file under the dropped entries, each carrying its folder path as
 * `webkitRelativePath`. Walks one folder level at a time and resolves each
 * level in parallel (one `entry.file()` round-trip per file would crawl on
 * a large Accounts folder). Unreadable entries are skipped; an aborted walk
 * stops issuing new reads and rejects with the signal's reason.
 *
 * Example:
 *   const files = await collectDroppedFiles([item.webkitGetAsEntry()]);
 *   files[0].webkitRelativePath; // -> "Accounts/1/1-S2-1-267727/Replays/Multiplayer/a.SC2Replay"
 */
export async function collectDroppedFiles(roots: ReadonlyArray<FileSystemEntry>, signal?: AbortSignal): Promise<File[]> {
  const files: File[] = [];
  let level: FileSystemEntry[] = [...roots];
  while (level.length > 0 && files.length < MAX_DROPPED_FILES) {
    signal?.throwIfAborted();
    await appendFiles(level.filter(isFileEntry), files, signal);
    if (files.length >= MAX_DROPPED_FILES) break;
    level = (await Promise.all(level.filter(isDirectoryEntry).map((entry) => readChildren(entry, signal)))).flat();
  }
  return files.slice(0, MAX_DROPPED_FILES);
}
