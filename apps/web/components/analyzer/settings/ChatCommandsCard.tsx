"use client";

/**
 * ChatCommandsCard — what viewers can type in chat, with a one-tap
 * "Copy for your bio" export. Rendered in Settings → Overlay →
 * Multi-platform chat AND in the Help tab; both feed off the same
 * commandsGuide data, and the copied text follows the streamer's
 * chosen loyalty rank race.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { COMMAND_GROUPS, buildBioText } from "@/lib/multichat/commandsGuide";
import type { RankRace } from "@/lib/multichat/rankLadders";

export function ChatCommandsCard({ rankRace }: { rankRace: RankRace }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copyBio = async () => {
    try {
      await navigator.clipboard.writeText(buildBioText(rankRace));
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
      toast.success("Copied", {
        description: "Paste it into your Twitch/Kick/YouTube/TikTok bio or panels.",
      });
    } catch {
      toast.error("Couldn't copy", {
        description: "Your browser blocked clipboard access — try again.",
      });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-body font-medium text-text">
          Chat commands your viewers can use
        </div>
        <Button size="sm" variant="secondary" onClick={() => void copyBio()}>
          {copied ? (
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
          ) : (
            <ClipboardCopy className="mr-1 h-3.5 w-3.5" aria-hidden />
          )}
          {copied ? "Copied" : "Copy for your bio"}
        </Button>
      </div>
      <p className="text-caption text-text-dim">
        These work from every connected platform's chat — the overlay
        answers on stream, no bot needed. The copied bio text uses your
        selected loyalty rank theme.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {COMMAND_GROUPS.map((g) => (
          <div key={g.id} className="min-w-0 rounded-md border border-border p-2.5">
            <div className="text-caption font-semibold text-text">
              {g.emoji} {g.title}
            </div>
            <p className="mt-1 text-micro leading-relaxed text-text-dim">
              {g.intro}
            </p>
            <ul className="mt-1.5 space-y-1">
              {g.commands.map((c) => (
                <li key={c.syntax} className="flex min-w-0 items-baseline gap-2">
                  <code className="shrink-0 rounded bg-bg-surface px-1.5 py-0.5 text-micro font-semibold text-accent-cyan">
                    {c.syntax}
                  </code>
                  <span className="min-w-0 text-micro text-text-muted">
                    {c.description}
                    {c.aliases ? (
                      <span className="text-text-dim"> · also {c.aliases}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
