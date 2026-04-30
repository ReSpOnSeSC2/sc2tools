/**
 * Wizard foundation — extracted from index.html for size-rule compliance.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Babel-standalone compiles JSX in this file before execution.
 * The IIFE wrapper isolates lexical scope from the inline block in
 * index.html (which has its own `const { useState, ... } = React;`),
 * preventing redeclaration errors. Each exported component / helper
 * is attached to `window` at the bottom so the inline block's bare
 * JSX identifiers (e.g. `<SettingsView />`) resolve via the global
 * object at render time.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;

      // ============================================================
      // FIRST-RUN WIZARD (Stage 2.2)
      // ------------------------------------------------------------
      // Shown when GET /api/profile/exists returns { exists: false }.
      // Walks a non-technical user through 6 steps -- replay folder
      // discovery, identity selection, race preference, optional
      // Twitch / OBS / SC2Pulse connection tests, and a final "Apply
      // & start" that PUTs /api/profile + /api/config and kicks off
      // the initial macro backfill. All styling pulls from the design
      // tokens inlined at the top of the file (no hard-coded hex).
      // ============================================================

      const WIZARD_STEPS = [
        { id: 1, label: "Welcome" },
        { id: 2, label: "Replays" },
        { id: 3, label: "Identity" },
        { id: 4, label: "Race" },
        { id: 5, label: "Import" },
        { id: 6, label: "Integrations" },
        { id: 7, label: "Apply" },
      ];
      const WIZARD_RACES = ["Protoss", "Terran", "Zerg", "Random"];
      // The Express server exposes the overlay surface at /overlay (added
      // in Stage 2.2 as a static mount; see stream-overlay-backend/index.js).
      const WIZARD_OVERLAY_URL = "http://localhost:3000/overlay/";

      // Per-widget catalog. Each entry corresponds to a file in
      // SC2-Overlay/widgets/ and the metadata mirrors the per-widget
      // README so streamers can pick exactly the cards they want.
      // ``recommended`` flags the four-widget starter set.
      const WIZARD_OVERLAY_WIDGETS = [
        { file: "session.html", title: "Session",
          desc: "Live W-L, MMR delta, league badge, session duration. Always on.",
          trigger: "Persistent", w: 300, h: 100, recommended: true },
        { file: "scouting.html", title: "Scouting report",
          desc: "Consolidated pre-game card: opponent + race + MMR + cheese flag + favorite opener + your best historical answer.",
          trigger: "Pre-game ~22s", w: 500, h: 280, recommended: true },
        { file: "post-game.html", title: "Post-game reveal",
          desc: "What the opponent actually built, with an animated build-order timeline.",
          trigger: "Post-game ~16s", w: 500, h: 220, recommended: true },
        { file: "streak.html", title: "Streak splash",
          desc: "Center-screen ON FIRE / RAMPAGE / TILT pop-up.",
          trigger: "Post-game ~8s", w: 600, h: 200, recommended: true },
        { file: "topbuilds.html", title: "Top builds",
          desc: "Your six most-played builds with W-L. Always on.",
          trigger: "Persistent", w: 320, h: 240 },
        { file: "match-result.html", title: "Match result",
          desc: "Race vs race + VICTORY / DEFEAT + map + duration.",
          trigger: "Post-game ~15s", w: 400, h: 130 },
        { file: "opponent.html", title: "Opponent detected",
          desc: '"Opponent detected: <name>" pop-up at game start.',
          trigger: "Pre-game ~20s", w: 400, h: 110 },
        { file: "rematch.html", title: "Rematch",
          desc: "Your all-time record vs this specific opponent.",
          trigger: "Pre-game ~15s", w: 400, h: 130 },
        { file: "cheese.html", title: "Cheese alert",
          desc: "Warning if you've cheesed or been cheesed by this opponent before.",
          trigger: "Pre-game ~18s", w: 400, h: 130 },
        { file: "fav-opening.html", title: "Favorite opening",
          desc: "Opponent's most-frequent opener.",
          trigger: "Pre-game ~18s", w: 400, h: 130 },
        { file: "best-answer.html", title: "Best answer",
          desc: "Your best historical response to that opener.",
          trigger: "Pre-game ~18s", w: 400, h: 130 },
        { file: "rival.html", title: "Rival alert",
          desc: "Special pop-up for opponents you've played 5+ times.",
          trigger: "Pre-game ~16s", w: 420, h: 130 },
        { file: "meta.html", title: "Session meta",
          desc: "Most-faced opponent strategy this session.",
          trigger: "Post-game ~12s", w: 300, h: 100 },
        { file: "mmr-delta.html", title: "MMR delta",
          desc: '"+25 MMR" or "-30 MMR" splash.',
          trigger: "Post-game ~10s", w: 300, h: 100 },
        { file: "rank.html", title: "Rank up / down",
          desc: "League promotion / demotion notification.",
          trigger: "Post-game ~12s", w: 400, h: 130 },
        { file: "topbuilds-alt", file: "" }, // placeholder filtered out
      ].filter((w) => w.file);
      const WIZARD_DEFAULT_OBS_HOST = "127.0.0.1";
      const WIZARD_DEFAULT_OBS_PORT = 4455;
      const WIZARD_IDENTITY_SAMPLE = 100;

      // ---- Reusable wizard primitives ----------------------------

      function WizardCard({ children }) {
        return (
          <div role="dialog" aria-modal="true" aria-labelledby="wizard-title"
            style={{
              position: "fixed", inset: 0, zIndex: 1000,
              background: "rgba(10, 14, 26, 0.85)",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "var(--space-4)",
            }}>
            <div style={{
              width: "100%", maxWidth: "720px",
              background: "var(--color-bg-surface)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-xl)",
              fontFamily: "var(--font-family-ui)",
              maxHeight: "92vh", overflowY: "auto",
            }}>
              {children}
            </div>
          </div>
        );
      }

      function WizardProgressStrip({ step }) {
        return (
          <div style={{
            display: "flex", gap: "var(--space-2)",
            padding: "var(--space-4) var(--space-6) 0",
            position: "sticky", top: 0,
            background: "var(--color-bg-surface)",
          }}>
            {WIZARD_STEPS.map((s) => (
              <WizardProgressPill key={s.id} step={s} active={s.id === step}
                                  done={s.id < step} />
            ))}
          </div>
        );
      }

      function WizardProgressPill({ step, active, done }) {
        const bg = active
          ? "var(--color-info)"
          : done ? "var(--color-success)" : "var(--color-bg-elevated)";
        const fg = active || done
          ? "var(--color-text-on-accent)" : "var(--color-text-secondary)";
        return (
          <div aria-current={active ? "step" : undefined}
            style={{
              flex: 1, background: bg, color: fg,
              padding: "var(--space-1) var(--space-2)",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--font-size-xs)", textAlign: "center",
              fontWeight: active ? 600 : 500,
            }}>
            {step.id}. {step.label}
          </div>
        );
      }

      function WizardButton({ children, onClick, disabled, kind = "primary",
                             type = "button" }) {
        const palette = {
          primary:   { bg: "var(--color-info)",        fg: "var(--color-text-on-accent)" },
          secondary: { bg: "var(--color-bg-elevated)", fg: "var(--color-text-primary)"   },
          danger:    { bg: "var(--color-danger)",      fg: "var(--color-text-on-accent)" },
        }[kind] || {};
        return (
          <button type={type} onClick={onClick} disabled={!!disabled}
            style={{
              background: palette.bg, color: palette.fg,
              padding: "var(--space-2) var(--space-4)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-md)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1,
              fontSize: "var(--font-size-sm)", fontWeight: 500,
            }}>
            {children}
          </button>
        );
      }

      function WizardField({ label, htmlFor, children, hint }) {
        return (
          <label htmlFor={htmlFor} style={{
            display: "block", marginBottom: "var(--space-3)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}>
            <div style={{ marginBottom: "var(--space-1)" }}>{label}</div>
            {children}
            {hint
              ? <div style={{
                  marginTop: "var(--space-1)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-muted)",
                }}>{hint}</div>
              : null}
          </label>
        );
      }

      function WizardInput(props) {
        return (
          <input {...props} style={{
            width: "100%",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--color-bg-primary)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-family-ui)",
            fontSize: "var(--font-size-sm)",
            ...(props.style || {}),
          }} />
        );
      }

      function WizardError({ children }) {
        if (!children) return null;
        return (
          <div role="alert" aria-live="polite"
               style={{ color: "var(--color-danger)",
                        marginBottom: "var(--space-3)",
                        fontSize: "var(--font-size-sm)" }}>
            {children}
          </div>
        );
      }

      function WizardNavRow({ children }) {
        return (
          <div style={{ display: "flex", gap: "var(--space-2)",
                        marginTop: "var(--space-6)" }}>
            {children}
          </div>
        );
      }


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WIZARD_STEPS,
    WIZARD_RACES,
    WIZARD_OVERLAY_URL,
    WIZARD_OVERLAY_WIDGETS,
    WIZARD_DEFAULT_OBS_HOST,
    WIZARD_DEFAULT_OBS_PORT,
    WIZARD_IDENTITY_SAMPLE,
    WizardCard,
    WizardProgressStrip,
    WizardProgressPill,
    WizardButton,
    WizardField,
    WizardInput,
    WizardError,
    WizardNavRow
  });
})();
