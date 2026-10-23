/* eslint-disable @next/next/no-html-link-for-pages -- root crash recovery needs a full document navigation without the app router. */
"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { captureException } from "@/lib/sentry";
import { ISSUES_URL } from "@/lib/siteLinks";
import { errorReportMailto } from "@/lib/feedback/errorReport";
import { sanitisePagePath } from "@/lib/feedback/sanitise";

const THEME_SCRIPT = "try{var t=localStorage.getItem('sc2tools.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";
const THEME_CSS = ":root{--crash-bg:#0b0e14;--crash-text:#e6e9f0;--crash-muted:#9aa3b2;--crash-panel:#1a2233;--crash-link:#7dd3fc} @media(prefers-color-scheme:light){:root{--crash-bg:#f8fafc;--crash-text:#18202d;--crash-muted:#475569;--crash-panel:#e2e8f0;--crash-link:#0369a1}} [data-theme=light]{--crash-bg:#f8fafc;--crash-text:#18202d;--crash-muted:#475569;--crash-panel:#e2e8f0;--crash-link:#0369a1} [data-theme=dark]{--crash-bg:#0b0e14;--crash-text:#e6e9f0;--crash-muted:#9aa3b2;--crash-panel:#1a2233;--crash-link:#7dd3fc} button:focus-visible,a:focus-visible{outline:2px solid var(--crash-link);outline-offset:3px}";
const button: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "10px 16px", minHeight: 44, borderRadius: 8, border: "1px solid var(--crash-muted)", background: "var(--crash-panel)", color: "var(--crash-text)", fontSize: 15, fontWeight: 600, cursor: "pointer" };

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reference = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [path, setPath] = useState("/");
  useEffect(() => { void captureException(error); setPath(sanitisePagePath(window.location.pathname) || "/"); }, [error]);
  async function copy() {
    try { await navigator.clipboard.writeText(error.digest || ""); setCopied(true); }
    catch { const range = document.createRange(); if (reference.current) { range.selectNodeContents(reference.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } }
  }
  const report = ISSUES_URL + "/new?" + new URLSearchParams({ title: "SC2 Tools error (ref " + (error.digest || "unknown") + ")", body: "Error reference: " + (error.digest || "unknown") + "\nPage: " + path + "\n\nWhat were you doing?\n" });
  return <html lang="en"><head><style>{THEME_CSS}</style><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head><body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--crash-bg)", color: "var(--crash-text)", fontFamily: "system-ui, sans-serif" }}>
    <main style={{ maxWidth: 520, textAlign: "center" }}><h1 style={{ fontSize: 24 }}>SC2 Tools hit a critical error</h1><p style={{ color: "var(--crash-muted)", lineHeight: 1.6 }}>The whole page failed to render. Try again, or reload to get a fresh copy of the page.</p>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12 }}><button style={button} onClick={reset}>Try again</button><button style={button} onClick={() => window.location.reload()}>Reload page</button><a style={button} href="/">Go to home page</a></div>
      {error.digest ? <div style={{ marginTop: 24 }}><p>Error reference: <code ref={reference}>{error.digest}</code></p><button style={button} onClick={() => void copy()}>{copied ? "Copied" : "Copy reference"}</button><p><a style={{ color: "var(--crash-link)" }} href={report}>Report this problem</a></p><span role="status">{copied ? "Error reference copied" : ""}</span></div> : null}
      <p><a href={errorReportMailto({ digest: error.digest })} style={{ color: "var(--crash-link)" }}>Email support</a></p>
    </main></body></html>;
}
