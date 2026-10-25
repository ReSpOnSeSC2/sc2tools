// commandsGuide — the single source of truth for what viewers can
// type in chat. Feeds the ChatCommandsCard in Settings/Help AND the
// copy-for-bio text, so the docs can never drift from each other.
// (The commands themselves are implemented in useCommandAnswers,
// the engagement service's parsePick, and poll.ts.)

import { RANK_LADDERS, type RankRace } from "./rankLadders";
import catalog from "./chatCommandCatalog.generated.json";
import type { ChatCommandPreferences } from "./chatCommandPreferences";

export interface CommandEntry {
  /** e.g. "!rank" */
  syntax: string;
  /** Alternate spellings, e.g. "!level / !xp". */
  aliases?: string;
  description: string;
}

export interface CommandGroup {
  id: string;
  emoji: string;
  title: string;
  intro: string;
  commands: CommandEntry[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    id: "predictions",
    emoji: "🔮",
    title: "Predictions",
    intro:
      "While my next game is loading, call the result. Correct calls earn +10 Oracle points, scored against the real replay — the reveal shows whether chat was right, and top oracles hit the on-stream leaderboard.",
    commands: [
      { syntax: "!win", aliases: "!w", description: "you think I win this one" },
      { syntax: "!loss", aliases: "!lose / !l", description: "you think I choke" },
    ],
  },
  {
    id: "loyalty",
    emoji: "⚡",
    title: "Loyalty XP",
    intro:
      "Chatting earns XP on every platform, all counted together: 2 XP per message. Bonuses: Follow +10 · Gift +20 · Resub +40 · Sub +50 · Member +50 · Super Chat +60 · Gift subs +60 · Raid +100. Top supporters show on the wall; level-ups get announced live.",
    commands: [
      {
        syntax: "!rank",
        aliases: "!level / !xp",
        description: "your rank, XP, and distance to the next unit",
      },
    ],
  },
  {
    id: "voting",
    emoji: "🗳",
    title: "Voting",
    intro:
      "When a poll or build vote is on screen, your latest vote counts — change it any time before it closes. During a build vote you're literally picking my opening.",
    commands: [
      {
        syntax: "!1 / !2 / !3",
        aliases: "!vote 2",
        description: "vote for that option",
      },
    ],
  },
  {
    id: "stats",
    emoji: "📊",
    title: "Live stats",
    intro: "Ask about the game — the overlay answers on stream, no bot needed.",
    commands: catalog.commands.map(command => ({ syntax: `!${command.id}${"argument" in command ? ` ${command.argument}` : ""}`, description: command.description,
      ...(command.aliases.length ? { aliases: command.aliases.map(alias => `!${alias}`).join(" / ") } : {}) })),
  },
];

/**
 * Plain-text block for a stream bio / panel — themed with the
 * streamer's chosen loyalty ladder. Plain text on purpose: bios
 * don't render markdown.
 */
export function commandGroups(preferences?: ChatCommandPreferences): readonly CommandGroup[] {
  if (!preferences) return COMMAND_GROUPS;
  const commands = catalog.commands.map(command => ({ ...command, ...preferences.builtins.find(row => row.id === command.id) })).filter(command => command.enabled !== false && (!command.platforms || command.platforms.length > 0));
  const rows: CommandEntry[] = commands.map(command => ({ syntax: `!${command.trigger || command.id}${"argument" in command ? ` ${command.argument}` : ""}`, description: command.description,
    aliases: [...new Set([command.id, ...command.aliases])].filter(alias => alias !== (command.trigger || command.id)).map(alias => `!${alias}`).join(" / ") }));
  rows.push(...preferences.custom.filter(command => command.enabled && command.platforms.length > 0).map(command => ({ syntax: `!${command.trigger}`, description: "custom channel reply" })));
  return COMMAND_GROUPS.map(group => group.id === "stats" ? { ...group, commands: rows } : group);
}

export function buildBioText(rankRace: RankRace, preferences?: ChatCommandPreferences): string {
  const ladder = RANK_LADDERS[rankRace];
  const ladderLine = `${ladder.slice(0, ladder.length - 1).join(" → ")} → ${ladder[ladder.length - 1].toUpperCase()}`;
  const lines: string[] = [
    "💬 CHAT COMMANDS — work from Twitch, Kick, YouTube AND TikTok chat:",
    "",
    "🔮 PREDICTIONS — when my next game is loading, call it:",
    "!win — you think I win · !loss — you think I choke",
    "Right calls earn +10 Oracle points (checked against the real replay). Best oracles go on the on-stream leaderboard.",
    "",
    "⚡ LOYALTY XP — chatting earns XP on every platform, all counted together:",
    "• 2 XP per message",
    "• Follow +10 · Gift +20 · Resub +40 · Sub +50 · Member +50 · Super Chat +60 · Gift subs +60 · Raid +100",
    `Level up the ladder: ${ladderLine} (each rank takes more XP than the last).`,
    "!rank — check YOUR rank, XP and distance to the next unit (also !level / !xp)",
    "",
    "🗳 VOTING — when a poll or build vote is on screen:",
    "!1 / !2 / !3 — vote for that option (or !vote 2). Your latest vote counts until it closes.",
    "",
    "📊 STATS — ask about the game live:",
    ...commandGroups(preferences).find(group => group.id === "stats")!.commands.map(command => `${command.syntax} — ${command.description}${command.aliases ? ` (also ${command.aliases})` : ""}`),
  ];
  return lines.join("\n");
}
