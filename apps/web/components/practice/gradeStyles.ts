import type { GhostGradeLetter } from "@/lib/ghostGrade";

/** Grade letters keep the colours of the game page's Ghost grade; the letter itself is always the text. */
export const GRADE_TEXT_CLASS: Record<GhostGradeLetter, string> = {
  S: "text-success",
  A: "text-accent-cyan",
  B: "text-warning",
  C: "text-warning",
  D: "text-danger",
};
