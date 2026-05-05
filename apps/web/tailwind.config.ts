import type { Config } from "tailwindcss";

/**
 * Design tokens are CSS variables defined in app/globals.css under
 * :root[data-theme="dark"] and :root[data-theme="light"]. Colors are
 * stored as space-separated RGB channel triples and exposed here via
 * `rgb(var(--…) / <alpha-value>)` so opacity modifiers like
 * `bg-accent/30` work transparently.
 *
 * Do NOT add raw hex values here. If you need a new token, add it to
 * globals.css (both themes) first, then expose it through this map.
 */
const channel = (varName: string) => `rgb(var(${varName}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,js,jsx}",
    "./components/**/*.{ts,tsx,js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: channel("--bg"),
          surface: channel("--bg-surface"),
          elevated: channel("--bg-elevated"),
          subtle: channel("--bg-subtle"),
        },
        text: {
          DEFAULT: channel("--text"),
          muted: channel("--text-muted"),
          dim: channel("--text-dim"),
        },
        accent: {
          DEFAULT: channel("--accent"),
          hover: channel("--accent-hover"),
          cyan: channel("--accent-cyan"),
        },
        success: channel("--success"),
        warning: channel("--warning"),
        danger: channel("--danger"),
        race: {
          protoss: channel("--race-protoss"),
          terran: channel("--race-terran"),
          zerg: channel("--race-zerg"),
          random: channel("--race-random"),
        },
        border: {
          DEFAULT: channel("--border"),
          strong: channel("--border-strong"),
        },
      },
      boxShadow: {
        "halo-cyan": "0 0 60px var(--halo-cyan)",
        "halo-accent": "0 0 60px var(--halo-accent)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "display-xl": ["64px", { lineHeight: "72px", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display-lg": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "700" }],
        h1: ["36px", { lineHeight: "44px", letterSpacing: "-0.01em", fontWeight: "600" }],
        h2: ["28px", { lineHeight: "36px", letterSpacing: "-0.005em", fontWeight: "600" }],
        h3: ["22px", { lineHeight: "30px", fontWeight: "600" }],
        h4: ["18px", { lineHeight: "26px", fontWeight: "600" }],
        "body-lg": ["17px", { lineHeight: "26px" }],
        body: ["15px", { lineHeight: "24px" }],
        caption: ["13px", { lineHeight: "20px" }],
        mono: ["14px", { lineHeight: "22px" }],
      },
    },
  },
  plugins: [],
};

export default config;
