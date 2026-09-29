"use client";

import { useState } from "react";
import { Check, Copy, Mail, MonitorSmartphone, Share2 } from "lucide-react";
import { gaEvent } from "@/lib/analytics/gtag";

/**
 * SendToPcCard — what a phone or tablet visitor sees instead of a Windows
 * installer they can't use: a way to get the download page onto the PC
 * they play on (email it to themselves, share it, or copy it).
 *
 * The link carries utm tags (campaign "send_to_pc") so the PC visit it
 * produces is attributed to this card in Google Analytics, and each
 * action fires `download_link_sent` with its method.
 *
 * Example:
 *   <SendToPcCard />
 */

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com").replace(/\/+$/, "");

type SendMethod = "email" | "share" | "copy";

/** The download page URL with the attribution tags for one send method. */
export function sendToPcLink(method: SendMethod): string {
  const medium = method === "email" ? "email" : "share";
  return `${SITE_URL}/download?utm_source=sc2tools&utm_medium=${medium}&utm_campaign=send_to_pc`;
}

/** A mailto: link with no recipient, so the visitor mails themselves. */
export function sendToPcMailto(): string {
  const subject = "SC2 Tools agent for my PC";
  const body = `Download the free SC2 Tools agent on the PC you play StarCraft II on:\n${sendToPcLink("email")}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const BUTTON_CLASS = [
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-body font-semibold",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

export function SendToPcCard() {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const share = async () => {
    try {
      await navigator.share({
        title: "SC2 Tools agent",
        text: "Download the free SC2 Tools agent on my PC",
        url: sendToPcLink("share"),
      });
      gaEvent("download_link_sent", { method: "share" });
    } catch {
      // Dismissed share sheet: nothing was sent.
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sendToPcLink("copy"));
    } catch {
      return; // Clipboard blocked; the email and share options remain.
    }
    setCopied(true);
    gaEvent("download_link_sent", { method: "copy" });
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <article className="space-y-4 rounded-xl border border-accent-cyan/30 bg-bg-surface p-5 shadow-halo-cyan sm:p-6">
      <header className="flex items-start gap-3">
        <MonitorSmartphone className="mt-0.5 h-6 w-6 flex-shrink-0 text-accent-cyan" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h3 className="text-h3 font-semibold text-text">Install it on your PC</h3>
          <p className="text-body text-text-muted">
            The SC2 Tools agent runs on the Windows PC you play StarCraft II on. Send yourself the link and open it
            there.
          </p>
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        <a
          href={sendToPcMailto()}
          onClick={() => gaEvent("download_link_sent", { method: "email" })}
          className={`${BUTTON_CLASS} bg-accent-cyan text-white hover:bg-accent-cyan/90`}
        >
          <Mail className="h-5 w-5" aria-hidden />
          Email me the link
        </a>
        {canShare ? (
          <button type="button" onClick={() => void share()} className={`${BUTTON_CLASS} border border-border bg-bg-elevated text-text hover:bg-bg-subtle`}>
            <Share2 className="h-5 w-5" aria-hidden />
            Share link
          </button>
        ) : null}
        <button type="button" onClick={() => void copy()} className={`${BUTTON_CLASS} border border-border bg-bg-elevated text-text hover:bg-bg-subtle`}>
          {copied ? <Check className="h-5 w-5" aria-hidden /> : <Copy className="h-5 w-5" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
        </button>
      </div>
    </article>
  );
}
