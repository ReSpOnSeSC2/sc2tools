"use client";

import Link from "next/link";

export function WizardFoundation() {
  return (
    <div className="space-y-3 text-sm text-text-muted">
      <h2 className="text-lg font-semibold text-text">
        What is SC2 Tools?
      </h2>
      <p>
        Cloud-hosted opponent intel for StarCraft II ranked. Install the
        agent on your gaming PC, sign in here, and your opponents tab,
        build orders, and OBS overlay update live across every device.
      </p>
      <ul className="ml-5 list-disc space-y-1">
        <li>Detailed history of every ranked match.</li>
        <li>Opponent dossiers with detected strategies and timings.</li>
        <li>OBS overlay with 15+ widgets — opponent card, MMR delta, etc.</li>
        <li>Multi-folder replay imports, custom builds, community pool.</li>
      </ul>
      <p>
        All you need is a Battle.net account in good standing and a few
        recent ranked games.{" "}
        <Link href="/download">Download the agent →</Link>
      </p>
    </div>
  );
}
