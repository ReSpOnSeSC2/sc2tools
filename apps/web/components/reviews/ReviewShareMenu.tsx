"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Share2 } from "lucide-react";
import { gaEvent } from "@/lib/analytics/gtag";
import { discordShareText, redditShareUrl, reviewHeadline } from "@/lib/reviews";
import { useToastOptional } from "@/components/ui/Toast";
import { ReviewMenu, type ReviewMenuItem } from "./ReviewMenu";

const BUTTON = "inline-flex min-h-10 items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-3.5 text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function ReviewShareMenu({ path, question, matchup }: { path: string; question: string; matchup: string | null }) {
  const [absolute, setAbsolute] = useState<string | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toasts = useToastOptional();
  useEffect(() => { setAbsolute(new URL(path, window.location.origin).href); setFallbackText(null); }, [path]);
  async function copy(kind: "link" | "discord") {
    if (!absolute) return false;
    const text = kind === "link" ? absolute : discordShareText(absolute, question, matchup);
    try {
      await navigator.clipboard.writeText(text);
      setFallbackText(null); setNotice("Link copied"); toasts?.toast.success("Link copied");
      gaEvent("review_shared", { channel: kind }); return true;
    } catch { setFallbackText(text); return false; }
  }
  async function nativeShare() {
    if (!absolute || !navigator.share || !window.matchMedia?.("(pointer: coarse)").matches) return false;
    try {
      await navigator.share({ title: reviewHeadline(question, matchup), url: absolute });
      gaEvent("review_shared", { channel: "native" }); return true;
    } catch (error) { return (error as { name?: string })?.name === "AbortError"; }
  }
  const items: ReviewMenuItem[] = [
    ...(absolute ? [{ id: "reddit", label: "Post to Reddit", href: redditShareUrl(absolute, question, matchup), target: "_blank", rel: "noopener noreferrer", onSelect: () => gaEvent("review_shared", { channel: "reddit" }) }] : []),
    { id: "discord", label: "Copy for Discord", keepOpen: true, onSelect: () => copy("discord") },
    { id: "link", label: "Copy link", keepOpen: true, onSelect: () => copy("link") },
  ];
  return <><ReviewMenu label="Share this review" className={BUTTON} disabled={!absolute} items={items} onActivate={nativeShare} fallbackText={fallbackText} onClose={() => setFallbackText(null)}><Share2 className="h-4 w-4" aria-hidden /> Share <ChevronDown className="h-3.5 w-3.5" aria-hidden /></ReviewMenu><span role="status" className="sr-only">{notice}</span></>;
}
