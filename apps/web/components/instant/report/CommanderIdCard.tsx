import { useId } from "react";
import type { CommanderProfile } from "@/lib/instant/commanderProfile";
import type { CommanderAxisKey } from "@/lib/instant/commanderTaxonomy";

const LABELS: Record<CommanderAxisKey, string> = {
  repertoire: "Build repertoire",
  pace: "Game length",
  matchup_edge: "Matchup edge",
};
const MINIMUMS: Record<CommanderAxisKey, string> = {
  repertoire: "Needs 10 detected builds in this matchup.",
  pace: "Needs 10 games of at least 45 seconds in this matchup.",
  matchup_edge: "Needs 8 decided games against each race.",
};

export function CommanderIdCard({ profile, scanned }: { profile: CommanderProfile | null; scanned: boolean }) {
  const title = useId();
  return <section aria-labelledby={title} className="space-y-3 rounded-lg border border-line bg-bg-surface p-4">
    <h3 id={title} className="font-display text-h3 text-text">Commander ID</h3>
    {profile ? <>
      <p className="text-body font-semibold text-text">{profile.name}{profile.code === null ? " · Incomplete" : ""}</p>
      <p className="text-caption text-text-muted">{profile.matchup} · most played matchup for this profile. Based on {scanned ? "your scan" : "saved replays"}. Report filters do not change this ID.</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        {profile.axes.map(({ key, label }) => <div key={key} className="min-w-0 space-y-1">
          <dt className="text-caption font-semibold text-text">{LABELS[key]}</dt>
          <dd className="text-body text-text-muted">{label ?? "Not enough games"}</dd>
          {label ? null : <dd className="text-caption text-text-muted">{MINIMUMS[key]}</dd>}
        </div>)}
      </dl>
    </> : <p className="text-body text-text-muted">Add ranked 1v1 replays to see your playstyle.</p>}
  </section>;
}
