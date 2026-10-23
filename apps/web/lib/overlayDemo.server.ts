// Server-only caller boundary: reuse the API's pure sample builder instead of
// maintaining a second set of widget fixtures or broadcasting to live sources.
import { buildSamplePayload } from "../../api/src/services/overlayLiveSamples";
import type { LiveGamePayload } from "@/components/overlay/types";

export function localOverlaySample(widget?: string): LiveGamePayload {
  return { ...buildSamplePayload(widget), isTest: true, testNonce: "local-preview", ...(widget ? { testWidget: widget } : {}) };
}
