export const RIVAL_REQUEST_TIMEOUT_MS = 20000;

/** Abort alone cannot settle a held authentication/body promise. Race every
 * optional rival operation against cancellation and a real deadline; the
 * operation must still check its owner/scope after awaited authentication. */
export async function rivalRequest<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
  controller.signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(controller.signal.reason || new DOMException("Cancelled", "AbortError"));
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("Rival request timed out. Try again.")), RIVAL_REQUEST_TIMEOUT_MS);
  try { return await Promise.race([operation(), cancelled]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
}
