import { sha256Hex } from "./integrity";

/** Fingerprint local replay bytes without exposing the filename or path. */
export async function replayDigest(blob: Blob): Promise<string | null> {
  try {
    return await sha256Hex(await blob.arrayBuffer());
  } catch {
    return null;
  }
}
