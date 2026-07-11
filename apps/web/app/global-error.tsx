"use client";

import { useEffect } from "react";
import { captureException } from "@/lib/sentry";

/**
 * Last-resort boundary for crashes in the root layout itself (Header,
 * ClerkProvider, CookieBanner). It replaces the entire document, so it
 * cannot rely on the layout's fonts or CSS variables — everything here
 * is inline-styled and dependency-free on purpose. Without this file,
 * a root-layout crash surfaces Next's unstyled default error screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0e14",
          color: "#e6e9f0",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>
            SC2 Tools hit a critical error
          </h1>
          <p style={{ color: "#9aa3b2", fontSize: 15, lineHeight: 1.5 }}>
            The whole page failed to render. Reloading usually fixes it
            — if it keeps happening, please report it from the app.
            {error.digest ? (
              <>
                {" "}
                Error reference: <code>{error.digest}</code>
              </>
            ) : null}
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 8,
              border: "1px solid #2d3648",
              background: "#1a2233",
              color: "#e6e9f0",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}
