/**
 * Stop walking a dropped folder tree after this many files, so dropping a
 * whole drive by mistake cannot run away. A full Accounts folder is far below.
 */
const MAX_DROPPED_FILES = 50_000;

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
