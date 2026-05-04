import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Overlay",
  robots: { index: false, follow: false },
};

/**
 * The /overlay/* tree is rendered inside an OBS Browser Source. Strip
 * the site chrome (header, footer, page padding) and force a transparent
 * background so widgets composite cleanly over the user's gameplay
 * capture. This layout intentionally renders ONLY the page — no nav,
 * no user controls.
 */
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
      <style>{`
        html, body { background: transparent !important; }
        body > header, body > footer, body > main > footer { display: none !important; }
        main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
      `}</style>
      {children}
    </div>
  );
}
