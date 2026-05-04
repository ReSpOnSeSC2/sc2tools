import type { Config } from "tailwindcss";

// Theme matches the existing analyzer SPA's design tokens. When the
// shared design-tokens.css ships in Stage 1 of the master roadmap,
// import that file from here instead of duplicating values.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,js,jsx}",
    "./components/**/*.{ts,tsx,js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0d12",
          surface: "#11141b",
          elevated: "#161a23",
          subtle: "#1c2230",
        },
        text: {
          DEFAULT: "#e6e8ee",
          muted: "#9aa3b2",
          dim: "#6b7280",
        },
        accent: {
          DEFAULT: "#7c8cff",
          hover: "#94a0ff",
        },
        success: "#3ec07a",
        warning: "#e6b450",
        danger: "#ff6b6b",
        border: {
          DEFAULT: "#1f2533",
          strong: "#2a3142",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
