"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Play, Square } from "lucide-react";
import { gaEvent } from "@/lib/analytics/gtag";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";

/** No bearer token, theme data or Ghost loadout appears before an explicit reveal. */
export function maskedOverlayUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://sc2tools.invalid");
    const route = parsed.pathname.replace(/^(\/(?:overlay|dock)\/)[^/]+/, "$1••••••");
    return route === parsed.pathname ? "Private source URL" : `${url.startsWith("/") ? "" : parsed.origin}${route}`;
  } catch { return "Private source URL"; }
}

export function UrlRow({
  url,
  compact,
  onTest,
  testing,
  testDisabled,
  testTitle,
}: {
  url: string;
  compact: boolean;
  onTest?: () => void;
  testing?: boolean;
  testDisabled?: boolean;
  testTitle?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null), [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null), timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToastOptional()?.toast;
  const revealed = revealedUrl === url, fallback = fallbackUrl === url;
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);

  const onCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true); setFallbackUrl(null);
      gaEvent("overlay_url_copied");
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setFallbackUrl(url);
      toast?.info("Select and copy the private URL below");
    }
  };

  return (
    <div className="grid w-full min-w-0 max-w-full grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <code
        title={revealed ? url : "Private URL hidden"}
        aria-label={
          compact ? "Widget Browser Source URL" : "All-in-one Browser Source URL"
        }
        tabIndex={0}
        className={[
          "line-clamp-2 w-full min-w-0 max-w-full select-all break-all whitespace-normal rounded bg-bg-elevated p-2 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          compact ? "text-micro" : "text-caption",
        ].join(" ")}
      >
        {revealed ? url : maskedOverlayUrl(url)}
      </code>
      <div className="flex flex-none flex-wrap gap-2 sm:justify-self-end">
        <Button
          variant="secondary"
          data-widget-copy
          className="min-h-11"
          size="sm"
          onClick={() => void onCopy()}
          iconLeft={
            copied ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Copy className="h-4 w-4" aria-hidden />
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" size="sm" className="min-h-11" aria-pressed={revealed} onClick={() => { setRevealedUrl(revealed ? null : url); setFallbackUrl(null); }}>{revealed ? "Hide URL" : "Reveal"}</Button>
        {onTest ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onTest}
            className="min-h-11"
            // No loading spinner once testing starts — the Stop label
            // already conveys "in flight". The button stays enabled
            // so a second click triggers the cancel path.
            disabled={testDisabled}
            title={testTitle}
            iconLeft={
              testing ? (
                <Square className="h-4 w-4" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )
            }
          >
            {testing ? "Stop" : "Test"}
          </Button>
        ) : null}
      </div>
      {fallback ? <div className="min-w-0 sm:col-span-2"><label className="text-caption text-text-muted">Copy this private URL<input ref={field} aria-label="Copy this private URL" readOnly value={url} onFocus={event => event.currentTarget.select()} className="mt-1 w-full min-w-0 rounded border border-border bg-bg-surface p-2 font-mono text-caption text-text" /></label><p role="status" className="text-caption text-text-muted">Clipboard unavailable. The full URL is selected for copying.</p></div> : null}
    </div>
  );
}
