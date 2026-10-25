"use client";
import { Button } from "@/components/ui/Button";
import type { useOpponentScoutingPreference } from "@/lib/useOpponentScoutingPreference";

export function GroupingPreference({ preference }: { preference: ReturnType<typeof useOpponentScoutingPreference> }) {
  return <div className="min-w-0 space-y-1">
    <Button variant="ghost" size="sm" role="switch" aria-label="Group same player" aria-checked={preference.groupByPlayer}
      disabled={preference.loading || preference.saving || preference.unavailable} loading={preference.saving}
      title="Save grouping for your opponent list, dossier and live scouting across devices"
      onClick={() => void preference.setGroupByPlayer(!preference.groupByPlayer)}>
      Group same player <span className="text-text-muted">· {preference.loading ? "Loading…" : preference.groupByPlayer ? "On" : "Off"}</span>
    </Button>
    {preference.error ? <p role="alert" className="max-w-sm text-caption text-warning">{preference.error}{preference.unavailable ? <> <Button variant="ghost" size="sm" onClick={preference.retry}>Retry grouping</Button></> : null}</p> : null}
  </div>;
}
