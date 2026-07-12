"use client";

import { useState } from "react";
import { Check, Copy, Play, Square } from "lucide-react";
import { gaEvent } from "@/lib/analytics/gtag";
import { Button } from "@/components/ui/Button";

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

  const onCopy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    gaEvent("overlay_url_copied");
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid w-full min-w-0 max-w-full grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <code
        title={url}
        aria-label={
          compact ? "Widget Browser Source URL" : "All-in-one Browser Source URL"
        }
        tabIndex={0}
        className={[
          "line-clamp-2 w-full min-w-0 max-w-full select-all break-all whitespace-normal rounded bg-bg-elevated p-2 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          compact ? "text-micro" : "text-caption",
        ].join(" ")}
      >
        {url}
      </code>
      <div className="flex flex-none gap-2 sm:justify-self-end">
        <Button
          variant="secondary"
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
        {onTest ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onTest}
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
    </div>
  );
}
