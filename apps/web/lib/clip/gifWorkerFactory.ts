/** The clip GIF encoder runs off the main thread; see gifWorkerProtocol. */
export function createGifWorker(): Worker {
  return new Worker(new URL("./gifWorker.ts", import.meta.url), { type: "module" });
}
