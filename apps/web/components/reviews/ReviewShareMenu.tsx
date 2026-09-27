"use client";

import { useState } from "react";
import { Check, Copy, MessageCircle, Share2 } from "lucide-react";
import { gaEvent } from "@/lib/analytics/gtag";
import { discordShareText, redditShareUrl } from "@/lib/reviews";

const BUTTON = "inline-flex min-h-[40px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-3.5 text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Reddit (prefilled "[PvZ] … — timestamped replay review" title),
 * Discord (a copy-ready message) and a plain link copy.
 */
export function ReviewShareMenu({ path, question, matchup }: { path: string; question: string; matchup: string | null }) {
  const [copied, setCopied] = useState<"link" | "discord" | null>(null);
  const absolute = () => `${window.location.origin}${path}`;

  async function copy(kind: "link" | "discord") {
    const text = kind === "link" ? absolute() : discordShareText(absolute(), question, matchup);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      window.prompt("Copy this", text);
    }
    gaEvent("review_shared", { channel: kind });
  }

  return (
    <div role="group" aria-label="Share this review" className="flex flex-wrap items-center gap-2">
      <a
        className={BUTTON}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          gaEvent("review_shared", { channel: "reddit" });
          window.open(redditShareUrl(absolute(), question, matchup), "_blank", "noopener,noreferrer");
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden /> Post to Reddit
      </a>
      <button type="button" className={BUTTON} onClick={() => void copy("discord")}>
        {copied === "discord" ? <Check className="h-4 w-4 text-success" aria-hidden /> : <MessageCircle className="h-4 w-4" aria-hidden />}
        {copied === "discord" ? "Copied for Discord" : "Copy for Discord"}
      </button>
      <button type="button" className={BUTTON} onClick={() => void copy("link")}>
        {copied === "link" ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        {copied === "link" ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
