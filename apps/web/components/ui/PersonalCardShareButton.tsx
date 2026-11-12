"use client";

import { useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { trackCardShared } from "@/lib/analytics/shareEvents";
import type { PersonalShareCard } from "@/lib/personalShareCards";

export function PersonalCardShareButton({ card, label }: { card: PersonalShareCard; label: string }) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: true } | null>(null);

  async function share() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const { sharePersonalCard } = await import("@/lib/personalShareCardImage");
      const delivery = await sharePersonalCard(card);
      if (!delivery) return;
      trackCardShared({ card: card.kind, method: delivery.method });
      setFeedback({ text: delivery.feedback });
    } catch {
      setFeedback({ text: "Couldn’t share the image. Try again.", error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" className="min-h-11" aria-disabled={busy || undefined}
        aria-busy={busy || undefined} iconLeft={<Share2 className="h-4 w-4" aria-hidden />} onClick={() => void share()}>
        {busy ? "Sharing…" : label}
      </Button>
      {feedback ? (
        <p className={feedback.error ? "text-caption text-danger" : "text-caption text-text-muted"}
          role={feedback.error ? "alert" : "status"}>{feedback.text}</p>
      ) : null}
    </div>
  );
}
