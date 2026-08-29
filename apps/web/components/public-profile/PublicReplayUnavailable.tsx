"use client";

import { CloudOff, RefreshCcw } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export function PublicReplayUnavailable({ detail = false }: { detail?: boolean }) {
  const title = detail
    ? "Replay analysis temporarily unavailable"
    : "Replay archive temporarily unavailable";
  return (
    <section className="mx-auto max-w-2xl py-16">
      <h1 className="sr-only">{title}</h1>
      <EmptyStatePanel
        size="lg"
        icon={<CloudOff className="h-6 w-6 text-text-muted" aria-hidden />}
        title={title}
        description="We couldn't reach the replay service just now. This is usually a brief blip — try refreshing in a minute."
        action={
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>
            Try again
          </Button>
        }
      />
    </section>
  );
}
