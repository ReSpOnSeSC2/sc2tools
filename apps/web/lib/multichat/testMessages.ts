// Multichat Test-fire demo stream. When the streamer clicks Test in
// Settings → Overlay, the cloud stamps a synthetic ``overlay:live``
// payload (isTest + testWidget:"multichat") at the token's socket
// room; the widget then plays THIS scripted sequence so the streamer
// can position and style the source without waiting for real chat.
//
// Everything here is unmistakably sample content ("Test fire" copy,
// obviously-synthetic names) — the same contract as every other
// widget's Test button (see apps/api/src/services/overlayLiveSamples).

import type { ChatMessage } from "./types";

interface TestSeed {
  platform: ChatMessage["platform"];
  user: string;
  text: string;
  badges: ChatMessage["badges"];
  color?: string;
}

const TEST_SEQUENCE: readonly TestSeed[] = [
  {
    platform: "twitch",
    user: "TestViewer",
    text: "Test fire! This is how your Twitch chat will look.",
    badges: [],
    color: "#FF69B4",
  },
  {
    platform: "kick",
    user: "KickTester",
    text: "Kick messages land in the same feed.",
    badges: ["member"],
    color: "#75FD48",
  },
  {
    platform: "youtube",
    user: "YT Test Viewer",
    text: "YouTube live chat shows up here too :fire:",
    badges: ["member"],
  },
  {
    platform: "tiktok",
    user: "tiktok.tester",
    text: "and TikTok LIVE comments complete the set",
    badges: [],
  },
  {
    platform: "twitch",
    user: "ModOnDuty",
    text: "moderator badges render like this",
    badges: ["moderator"],
    color: "#1E90FF",
  },
  {
    platform: "kick",
    user: "TheStreamer",
    text: "broadcaster messages get the crown",
    badges: ["owner"],
    color: "#F5B942",
  },
  {
    platform: "youtube",
    user: "LongMessageTester",
    text: "Longer messages wrap cleanly instead of stretching the panel — tune the width in OBS and the text follows.",
    badges: [],
  },
  {
    platform: "twitch",
    user: "CommandTester",
    text: "!discord — command lines vanish if you enable Hide commands",
    badges: [],
    color: "#9ACD32",
  },
];

/**
 * Build one demo message per tick. ``index`` walks the sequence;
 * ``atMs`` stamps arrival time so TTL / timestamp settings behave
 * exactly as they would with real chat.
 */
export function testChatMessage(index: number, atMs: number): ChatMessage | null {
  const seed = TEST_SEQUENCE[index];
  if (!seed) return null;
  return {
    platform: seed.platform,
    id: `test-${index}-${atMs}`,
    user: seed.user,
    text: seed.text,
    color: seed.color,
    badges: seed.badges,
    atMs,
  };
}

export const TEST_SEQUENCE_LENGTH = TEST_SEQUENCE.length;
/** Cadence of the demo stream. */
export const TEST_MESSAGE_INTERVAL_MS = 850;
