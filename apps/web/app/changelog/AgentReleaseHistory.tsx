import Link from "next/link";
import { MiniMarkdown } from "@/components/ui/MiniMarkdown";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { agentReleaseAnchor, agentReleaseMarkdown, getAgentReleaseNotes } from "@/lib/agentReleases";

export function AgentReleaseHistory() {
  const releases = getAgentReleaseNotes();
  return (
    <section id="agent-release-notes" className="scroll-mt-24 space-y-4" aria-labelledby="agent-release-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="agent-release-title" className="text-h2 font-bold text-text">Agent release notes</h2>
        <Link className={buttonClassName({ variant: "ghost" })} href="/changelog/agent.xml" prefetch={false}>Agent RSS feed</Link>
      </div>
      <ol className="space-y-2">
        {releases.map(({ version, date, notes }, index) => (
          <li key={version}>
            <details className="rounded-xl border border-border bg-bg-surface" open={index === 0}>
              <summary className="min-h-11 cursor-pointer rounded-xl px-4 py-3 text-body font-semibold text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                Agent {version}
                {date && <time className="ml-3 text-caption font-normal text-text-muted" dateTime={date}>{date}</time>}
              </summary>
              <div id={agentReleaseAnchor(version)} className="scroll-mt-24 border-t border-border p-4">
                <MiniMarkdown text={agentReleaseMarkdown(version, notes)} />
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
