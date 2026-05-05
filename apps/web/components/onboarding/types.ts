/** Platform we can offer a download artifact for. */
export type DetectedOS = "windows" | "macos" | "linux" | "unknown";

/** Shape returned by `GET /v1/agent/version`. */
export interface AgentVersionResp {
  ok: boolean;
  channel: string;
  platform: string;
  /** True iff `current` is older than `latest`. */
  update_available: boolean;
  current?: string;
  latest?: string;
  publishedAt?: string;
  releaseNotes?: string;
  minSupportedVersion?: string | null;
  artifact?: {
    platform: string;
    downloadUrl: string;
    sha256: string;
    sizeBytes: number | null;
    signature: string | null;
  };
}

/** Shape returned by `POST /v1/device-pairings/start`. */
export interface DevicePairingStartResp {
  /** 6-character user-facing code, e.g. "AB12CD". */
  code: string;
  /** Server-side expiry timestamp; agent uses this to drop stale handshakes. */
  expiresAt: string;
}

/** Shape returned by `GET /v1/device-pairings/:code`. */
export interface DevicePairingPollResp {
  status: "pending" | "ready" | "expired";
  /** Present once status === "ready". */
  userId?: string;
}

/** Step ids for the 3-step onboarding wizard. */
export type OnboardingStepId = "welcome" | "download" | "pair";
