import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Overlay",
  robots: { index: false, follow: false },
};

/**
 * The /overlay/* tree is rendered inside an OBS Browser Source. Strip
 * the site chrome (header, footer, page padding, cookie banner) and
 * force a transparent background so widgets composite cleanly over the
 * user's gameplay capture.
 *
 * Theme: overlay routes are dark-only by contract. The streamer's
 * personal preference (light/dark) does not apply here — broadcast
 * styling needs to look the same regardless of who set up the URL.
 * We override the root layout's no-flash bootstrap with an inline
 * script that runs before paint and pins data-theme="dark".
 *
 * Reliability over purity: this layout intentionally renders ONLY the
 * page — no nav, no user controls — and uses raw hex / CSS instead of
 * design tokens because OBS Browser Sources strip preferences and we
 * want predictable rendering.
 */
const FORCE_DARK_SCRIPT = `(function(){try{document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`;

export default function OverlayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "transparent",
        minHeight: "100vh",
        margin: 0,
        padding: 0,
      }}
    >
      <script
        // Sync theme-force — must run before paint, before WidgetShell mounts.
        dangerouslySetInnerHTML={{ __html: FORCE_DARK_SCRIPT }}
      />
      <style>{`
        html, body { background: transparent !important; }
        body > header, body > footer, body > main > footer { display: none !important; }
        [data-cookie-banner] { display: none !important; }
        main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
        @media (prefers-reduced-motion: reduce) {
          .widget-shell {
            transition: opacity 120ms linear !important;
            transform: none !important;
            animation: none !important;
          }
          .widget-shell .widget-halo { animation: none !important; }
        }
        @keyframes widgetHaloPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        @keyframes voiceGesturePulse {
          0%, 100% { box-shadow: 0 6px 20px rgba(0,0,0,0.55), 0 0 24px rgba(62,192,199,0.18); }
          50%      { box-shadow: 0 6px 20px rgba(0,0,0,0.55), 0 0 36px rgba(62,192,199,0.42); }
        }
        @media (prefers-reduced-motion: reduce) {
          .voice-gesture-banner { animation: none !important; }
        }
      `}</style>
      {children}
    </div>
  );
}
