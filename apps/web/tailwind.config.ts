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
    // RULE_TONE_STRIPE (lib/build-rules-quantity.ts) holds class names.
    "./lib/build-rules*.ts",
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
        // Command Glass aurora stops: cyan -> azure -> violet. Decorative
        // gradients only (hero type, beams, rings); see globals.css.
        aurora: {
          1: channel("--aurora-1"),
          2: channel("--aurora-2"),
          3: channel("--aurora-3"),
        },
        // Warm "signal" colour — reserved for rare emphasis (NEW flags,
        // hero numbers). The single warm note against the cool palette.
        signal: {
          DEFAULT: channel("--signal"),
          hover: channel("--signal-hover"),
        },
        // Clay / dusty-rose editorial accent — the "1 unusual accent" of the
        // landing palette. Warm and earthy against the cool teal/cyan so the
        // marketing page escapes the stock 3-colour look.
        editorial: {
          DEFAULT: channel("--editorial"),
          soft: channel("--editorial-soft"),
        },
        success: channel("--success"),
        warning: channel("--warning"),
        danger: channel("--danger"),
        // Head-to-head series colours: you (blue) vs opponent (red).
        player: {
          you: channel("--player-you"),
          opp: channel("--player-opp"),
        },
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
        // Card and panel edge hairline (decorative; controls use
        // border-border-strong). See ADR 0099.
        line: channel("--line"),
      },
      // Text and filled controls need different contrast on each surface.
      textColor: {
        accent: { DEFAULT: channel("--accent-ink"), hover: channel("--accent-ink-hover"), cyan: channel("--accent-cyan") },
      },
      backgroundColor: { danger: channel("--danger-fill") },
      // Named layers for everything pinned to the viewport, lowest first.
      // Use these instead of raw z-40/z-50/z-[60] so a new floating surface
      // lands in the right place. Scale and rules: docs/design-system.md
      // ("Layers and the bottom edge").
      zIndex: {
        // The app rail and the mobile tab bar.
        nav: "40",
        // Sheets and drawers opened from the nav (the More sheet).
        sheet: "50",
        // Bars that float over content: Save bar, update prompt, cookie banner.
        banner: "50",
        // Toasts sit above everything except the skip link.
        toast: "60",
      },
      inset: {
        // `bottom-above-chrome`: where floating bottom surfaces sit. AppChrome
        // publishes the mobile tab bar's height (safe-area padding included)
        // as --chrome-bottom; it is 0 on md+ where the bar is hidden, and
        // unset outside the app, where the safe area alone applies. Keep the
        // custom property name in sync with CHROME_BOTTOM_VAR
        // (components/chrome/chromeInsets.ts).
        "above-chrome":
          "calc(max(var(--chrome-bottom, 0px), env(safe-area-inset-bottom, 0px)) + 0.75rem)",
      },
      boxShadow: {
        "halo-cyan": "0 0 60px var(--halo-cyan)",
        "halo-accent": "0 0 60px var(--halo-accent)",
        // Resting elevation for cards and controls: a soft layered shadow
        // with a faint top highlight. `hard` is the legacy name of the same
        // token, kept so existing call-sites follow the system.
        hard: "var(--shadow-hard)",
        card: "var(--shadow-card)",
        // Floating surfaces: dialogs, popovers, menus, toasts, sheets.
        pop: "var(--shadow-pop)",
        // Interactive emphasis: a cyan edge and glow (hover, featured).
        glow: "var(--shadow-glow)",
      },
      backgroundImage: {
        sheen: "var(--sheen)",
        aurora:
          "linear-gradient(100deg, rgb(var(--aurora-1)) 0%, rgb(var(--aurora-2)) 55%, rgb(var(--aurora-3)) 100%)",
      },
      // Softer, more modern corners across the existing scale: every
      // rounded-md/lg/xl/2xl call-site picks this up without an edit.
      borderRadius: {
        md: "0.4375rem",
        lg: "0.625rem",
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      keyframes: {
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "sheet-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
      },
      animation: {
        "rise-in": "rise-in var(--dur-slow) var(--ease-out) both",
        "scale-in": "scale-in var(--dur-base) var(--ease-out) both",
        "sheet-up": "sheet-up var(--dur-slow) var(--ease-out) both",
        shimmer: "shimmer 1.6s var(--ease-in-out) infinite",
        "beam-pulse": "beamPulse 2.8s var(--ease-in-out) infinite",
      },
      fontFamily: {
        // Body/UI face — Hanken Grotesk via next/font (`--font-sans`), set on
        // <html> in app/layout.tsx, with a full system fallback.
        sans: [
          "var(--font-sans)",
          "Hanken Grotesk",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // Display — the same variable Hanken Grotesk at heavier weights with
        // tight tracking. Command Glass is one family: headings, the
        // wordmark and big numbers stay in voice with the UI around them.
        display: [
          "var(--font-sans)",
          "Hanken Grotesk",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // `font-serif` stays as a utility name for older long-form markup
        // but resolves to the same family: the serif magazine treatment was
        // retired with the Command Glass system (ADR 0099).
        serif: [
          "var(--font-sans)",
          "Hanken Grotesk",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // Numeric/technical monospace — the platform's modern mono first.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Cascadia Mono",
          "Segoe UI Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // Custom motion curves so transitions read intentional rather than
      // using the browser-default ease. `--ease-*`/`--dur-*` live in
      // globals.css; DEFAULT here means every `transition-*` utility and
      // explicit `duration-*` inherits the smooth ease-out unless told
      // otherwise.
      transitionTimingFunction: {
        DEFAULT: "var(--ease-out)",
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
      transitionDuration: {
        DEFAULT: "var(--dur-base)",
      },
      fontSize: {
        // rem (16px base), so Settings → Appearance text size scales every
        // size from <html>: pixel-identical at 100%. Mirrored by the .t-*
        // utilities in globals.css.
        // Courtside: heavier display weights + tighter tracking for the
        // athletic-editorial voice.
        "display-xl": ["4rem", { lineHeight: "4.25rem", letterSpacing: "-0.04em", fontWeight: "800" }],
        "display-lg": ["3rem", { lineHeight: "3.25rem", letterSpacing: "-0.035em", fontWeight: "800" }],
        h1: ["2.25rem", { lineHeight: "2.625rem", letterSpacing: "-0.03em", fontWeight: "750" }],
        h2: ["1.75rem", { lineHeight: "2.125rem", letterSpacing: "-0.025em", fontWeight: "700" }],
        h3: ["1.375rem", { lineHeight: "1.75rem", letterSpacing: "-0.02em", fontWeight: "700" }],
        h4: ["1.125rem", { lineHeight: "1.5rem", letterSpacing: "-0.015em", fontWeight: "650" }],
        "body-lg": ["1.0625rem", { lineHeight: "1.625rem" }],
        body: ["0.9375rem", { lineHeight: "1.5rem" }],
        caption: ["0.8125rem", { lineHeight: "1.25rem" }],
        // Smallest token in the scale — for dense labels/overlines.
        // Nothing should render below this (12px) floor.
        micro: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
        mono: ["0.875rem", { lineHeight: "1.375rem" }],
      },
    },
  },
  plugins: [],
};

export default config;
