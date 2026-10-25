import { getJsonWithStatus } from "@/lib/serverApi";

export const PUBLIC_OG_READ_TIMEOUT_MS = 2500;

/** The deadline covers response headers and JSON. A stalled upstream/body
 * yields the same neutral card as an unavailable public document. */
export async function readPublicOg<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getJsonWithStatus<T>(path, { signal: controller.signal }).then(result => result.data),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, PUBLIC_OG_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
