/** Clerk needs literal colors. Keep these mirrors aligned with globals.css. */
export const THEME_TOKENS = {
  dark: {
    accent: "#157d8c", "bg-surface": "#0b0f16", "bg-elevated": "#121722",
    text: "#edf2f7", "text-muted": "#a3afbf", danger: "#ff6b6b", success: "#3ec884", warning: "#e89c38",
  },
  light: {
    accent: "#0e7d8c", "bg-surface": "#ffffff", "bg-elevated": "#fafbfd",
    text: "#0b1220", "text-muted": "#3f4856", danger: "#b8333a", success: "#157a43", warning: "#8f5f0f",
  },
} as const;
