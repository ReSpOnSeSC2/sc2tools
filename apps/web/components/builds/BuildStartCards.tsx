"use client";

import Link from "next/link";
import { ClipboardList, FilePlus2, Film, ScanText } from "lucide-react";

export type BuildStartChoice = "games" | "detected" | "blank";

/** Thin enough for the first-run library; editor/catalog code stays lazy. */
export function BuildStartCards({ onChoose, community = false }: {
  onChoose: (choice: BuildStartChoice) => void;
  community?: boolean;
}) {
  const cards = [
    { choice: "games" as const, title: "From one of my games", text: "Pick a replay here, or open any game and click Save as new build on its build order.", Icon: Film },
    { choice: "detected" as const, title: "From a detected build", text: "Choose an analyzer label, then a matching replay as your starting point.", Icon: ScanText },
    { choice: "blank" as const, title: "Blank build", text: "Start with no rules and choose actions from the token picker.", Icon: FilePlus2 },
  ];
  const cardClass = "flex min-h-11 min-w-0 flex-col items-start gap-2 rounded-xl border-2 border-line bg-bg-surface p-4 text-left text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.slice(0, 2).map(({ choice, title, text, Icon }) => <button key={choice} type="button" className={cardClass} onClick={() => onChoose(choice)}><Icon className="h-5 w-5 text-accent" aria-hidden /><span className="font-semibold">{title}</span><span className="text-caption text-text-muted">{text}</span></button>)}
      <button type="button" className={`${cardClass} cursor-not-allowed opacity-70`} disabled><ClipboardList className="h-5 w-5" aria-hidden /><span className="font-semibold">From a pasted build order</span><span className="text-caption text-text-muted">Coming with reference build orders. Pasting is not available yet.</span></button>
      {cards.slice(2).map(({ choice, title, text, Icon }) => <button key={choice} type="button" className={cardClass} onClick={() => onChoose(choice)}><Icon className="h-5 w-5 text-accent" aria-hidden /><span className="font-semibold">{title}</span><span className="text-caption text-text-muted">{text}</span></button>)}
      {community ? <Link href="/community" className={cardClass}><span className="font-semibold">Copy a Community build</span><span className="text-caption text-text-muted">Browse shared builds and save a private copy before editing.</span></Link> : null}
    </div>
    <p className="text-caption text-text-muted"><Link className="inline-flex min-h-11 items-center font-medium text-text underline underline-offset-2" href="/definitions">See the built-in labels</Link>.</p>
  </div>;
}
