import type { StudioState } from "@/lib/multichat/useStudioState";

/** A retry callback reads the panel's current form, including newer edits. */
export type DockPost = (
  patch: Record<string, unknown>,
  retry?: () => Promise<StudioState | null>,
) => Promise<StudioState | null>;
