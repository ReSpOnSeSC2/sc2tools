/** Clerk needs literal colors. Keep these mirrors aligned with globals.css. */
export const THEME_TOKENS = {
  dark: {
    accent: "#157d8c", "bg-surface": "#0c1017", "bg-elevated": "#111720",
    text: "#e7edf0", "text-muted": "#9fadb9", danger: "#ff6b6b", success: "#3ec884", warning: "#e89c38",
  },
  light: {
    accent: "#0e7d8c", "bg-surface": "#ffffff", "bg-elevated": "#f9fbfe",
    text: "#0d121a", "text-muted": "#3f4856", danger: "#d24449", success: "#1c9c56", warning: "#b07618",
  },
} as const;
