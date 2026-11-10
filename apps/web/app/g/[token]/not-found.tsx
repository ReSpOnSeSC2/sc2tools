import Link from "next/link";
import { Link2Off } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

/** A turned-off, deleted and mistyped link all read the same. */
export default function SharedGameNotFound() {
  return <section className="mx-auto max-w-2xl py-16">
    <EmptyStatePanel size="lg" icon={<Link2Off className="h-6 w-6" aria-hidden />}
      title={<h1 className="text-h3 font-bold text-text">This share link isn&apos;t available</h1>}
      description="The player may have turned the link off or removed the game, or the link is mistyped."
      action={<Link href="/" className="inline-flex min-h-11 items-center font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Go to SC2 Tools</Link>} />
  </section>;
}
