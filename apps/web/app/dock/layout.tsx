import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Stream Dock",
  robots: { index: false, follow: false },
};

/**
 * The /dock/* tree is rendered inside an OBS Custom Browser Dock (or a
 * phone/second monitor). Same chrome-stripping contract as the
 * /overlay/* layout — no site header, footer, padding or cookie banner
 * — but where the overlay composites transparently over gameplay, the
 * dock is an opaque control panel: dark-only by contract, with its own
 * solid background so it reads as a panel wherever it's docked.
 *
 * Theme: forced dark before paint, exactly like the overlay layout —
 * OBS docks strip preferences and broadcast tooling must render
 * predictably regardless of who set up the URL.
 */
const FORCE_DARK_SCRIPT = `(function(){try{document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`;

export default function DockLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#0b0e14",
        minHeight: "100vh",
        margin: 0,
        padding: 0,
      }}
    >
      <script
        // Sync theme-force — must run before paint.
        dangerouslySetInnerHTML={{ __html: FORCE_DARK_SCRIPT }}
      />
      <style>{`
        html, body { background: #0b0e14 !important; }
        body > header, body > footer, body > main > footer { display: none !important; }
        [data-cookie-banner] { display: none !important; }
        main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
      `}</style>
      {children}
    </div>
  );
}
