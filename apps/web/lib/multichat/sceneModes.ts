/** Dock modes control copy independently of the selected OBS backdrop. */
export const STUDIO_SCENE_HEADLINES = {
  starting: "STARTING SOON",
  brb: "BE RIGHT BACK",
  intermission: "INTERMISSION",
  ending: "THANKS FOR WATCHING",
} as const;
export type StudioSceneMode = keyof typeof STUDIO_SCENE_HEADLINES;
export const STUDIO_SCENE_LABELS: Record<StudioSceneMode, string> = {
  starting: "Starting Soon", brb: "BRB", intermission: "Intermission", ending: "Stream ending",
};
