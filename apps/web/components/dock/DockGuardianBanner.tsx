import { GUARDIAN_COPY, GUARDIAN_EXPIRES_MS, minutesActive, type GuardianState } from "@/lib/multichat/streamGuardian";

/** Off-stream warnings from the agent's Stream Guardian. Lives in the Dock only: no overlay ever shows it and nothing here makes a sound. */
export function DockGuardianBanner({ guardian, now }: { guardian: GuardianState | null; now: number }) {
  if (!guardian || !guardian.warnings.length || now - guardian.receivedAt > GUARDIAN_EXPIRES_MS) return null;
  return <ul role="alert" aria-label="Stream Guardian warnings" className="space-y-1">
    {guardian.warnings.map(({ rule, since }) => <li key={rule} className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-caption text-danger">
      {GUARDIAN_COPY[rule]}{since > 0 ? ` For ${minutesActive(since, now)} min.` : ""}
    </li>)}
  </ul>;
}
