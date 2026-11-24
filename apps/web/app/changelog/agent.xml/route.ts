import { agentReleaseAnchor, getAgentReleaseNotes } from "@/lib/agentReleases";
import { rssResponse } from "@/lib/rss";

export const dynamic = "force-static";
// Starts at the newest published agent release on GitHub, like the
// changelog page: rendered again at most every 10 minutes.
export const revalidate = 600;

export async function GET() {
  const items = (await getAgentReleaseNotes()).map(({ version, notes, date }) => ({
    path: `/changelog#${agentReleaseAnchor(version)}`,
    title: `SC2 Tools Agent ${version}`,
    description: notes,
    date,
  }));
  return rssResponse("SC2 Tools Agent release notes", "Changes to the SC2 Tools desktop app", "/changelog#agent-release-notes", items);
}
