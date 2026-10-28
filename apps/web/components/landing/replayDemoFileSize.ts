/** File.size is a nonnegative integer. Keep the existing two-decimal MB label
 * while showing small local files in units that cannot round them to zero. */
export function replayDemoFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
