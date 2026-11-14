type ToolGate = "browser" | "guides" | "reviews";


type Tool = {
  href: string;
  title: string;
  description: string;
  gate?: ToolGate;
};

type ToolSection = { id: string; title: string; tools: readonly Tool[] };

const CATALOG: readonly ToolSection[] = [
  {
    id: "play",
    title: "Play and compete",
    tools: [
      { href: "/arcade", title: "SC2 Daily", description: "Pick the winner of five StarCraft II fights and compare your calls." },
      { href: "/arcade/scout", title: "Daily Scout", description: "Identify five openings from building positions and timings." },
      { href: "/match", title: "Match Rooms", description: "Set up a series, veto maps, and keep score with an invite link." },
    ],
  },
  {
    id: "ladder",
    title: "Study the ladder",
    tools: [
      { href: "/balance", title: "Ladder Balance", description: "Compare matchup win rates and sample sizes by league tier." },
      { href: "/balance/claim", title: "Claim Builder", description: "Check a matchup claim and share a Balance Receipt pinned to its source." },
      { href: "/permit", title: "Whine Permit", description: "Compare your own win–loss record with your ladder tier." },
      { href: "/guides", title: "Build guides", description: "Browse openers by matchup with timings and examples.", gate: "guides" },
      { href: "/community", title: "Community builds", description: "Browse builds shared by other players." },
      { href: "/reviews", title: "Replay reviews", description: "Browse public feedback on other players’ replays.", gate: "reviews" },
    ],
  },
  {
    id: "replays",
    title: "Analyze your replays",
    tools: [
      { href: "/try", title: "Instant Analysis", description: "Read your builds, results, and macro from replays on this device.", gate: "browser" },
      { href: "/try#balance-court", title: "Replay verdict", description: "Open Balance Court to compare a ranked loss with your ladder cohort and replay evidence.", gate: "browser" },
      { href: "/wrapped", title: "2026 Wrapped", description: "Create a shareable recap from your 2026 ladder replays.", gate: "browser" },
      { href: "/career", title: "Replay Career", description: "See your ladder history across years from your replay files.", gate: "browser" },
    ],
  },
  {
    id: "setup",
    title: "Account, Windows, and streaming",
    tools: [
      { href: "/app", title: "Open your dashboard", description: "Sign in for synced games, opponent reports, practice, and notifications." },
      { href: "/download", title: "Download the Windows Agent", description: "Install automatic replay sync and the in-game Companion." },
      { href: "/stream-studio", title: "Stream Studio", description: "Explore the OBS overlay, Stream Dock, and chat tools." },
      { href: "/help", title: "Help", description: "Find setup instructions and help with individual tools." },
      { href: "/changelog", title: "Release notes", description: "See what changed in SC2 Tools and the Windows Agent." },
    ],
  },
];

export function toolsCatalog(gates: Readonly<Record<ToolGate, boolean>>): ToolSection[] {
  return CATALOG.map(section => ({ ...section, tools: section.tools.filter(tool => !tool.gate || gates[tool.gate]) }))
    .filter(section => section.tools.length > 0);
}
