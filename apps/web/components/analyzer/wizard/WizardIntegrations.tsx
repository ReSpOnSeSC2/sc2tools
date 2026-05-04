"use client";

import Link from "next/link";

export function WizardIntegrations() {
  return (
    <div className="space-y-3 text-sm text-text-muted">
      <h2 className="text-lg font-semibold text-text">Optional integrations</h2>
      <ul className="ml-5 list-disc space-y-2">
        <li>
          <strong>OBS overlay.</strong> Mint a token in{" "}
          <Link href="/streaming">Streaming</Link> and paste the URL into a
          Browser Source. Choose which widgets you want active per stream.
        </li>
        <li>
          <strong>SC2ReplayStats / Spawning Tool.</strong> Continue using
          them — the agent is read-only on your replays folder. SC2 Tools
          will not interfere.
        </li>
        <li>
          <strong>Discord.</strong> If a community bot exists for your team,
          you can have new community builds posted to a channel.
        </li>
      </ul>
    </div>
  );
}
