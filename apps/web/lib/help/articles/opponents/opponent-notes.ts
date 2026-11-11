import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "opponent-notes",
  title: "Opponent notes & tags",
  summary:
    "Write one note per opponent account, tag it, choose whether it may appear on stream, and let it follow the player's other accounts.",
  category: "opponents",
  audience: "player",
  signedInOnly: true,
  order: 2,
  keywords: [
    "notes",
    "scouting notes",
    "opponent note",
    "tags",
    "cheeser",
    "proxy",
    "toxic",
    "smurf",
    "private",
    "show on stream",
    "read aloud",
    "alt accounts",
    "all their accounts",
  ],
  updated: "2026-11-10",
  body: [
    { type: "heading", text: "Where to write a note", anchor: "where" },
    { type: "list", items: [
      "The **Opponent notes** card in an opponent's dossier has every option: text, tags, Show on stream, Read aloud and All their accounts.",
      "**Add note** in your live scouting brief and **Opponent note** in a game's header are quick editors for the text and Show on stream. They keep the tags and other settings you chose in the dossier.",
      "The paired desktop app edits the same note.",
    ] },
    { type: "paragraph", text: "Each opponent account has one note of up to 500 characters with up to 8 tags. A blank note is deleted." },
    { type: "heading", text: "Private or on stream", anchor: "visibility" },
    { type: "paragraph", text: "New notes are private: they appear only in your own views. Turn on **Show on stream** to let the note appear on your OBS scouting widget. Only notes with Show on stream on appear on stream, and a note tagged Toxic never does. **Read aloud** adds a stream note to the voice readout and needs Voice → Scouting Report in your overlay settings." },
    { type: "callout", tone: "info", title: "Notes written before this change", text: "Notes always appeared on the scouting widget before private notes existed, so your earlier notes keep doing that until you change them. The dossier shows a one-time banner on those notes; turn off Show on stream to keep one to yourself." },
    { type: "paragraph", text: "Private notes appear in the dossier, the Opponents list notes preview, your live brief on the dashboard and second screen, and the paired desktop app. No note reaches your public profile, shared replays or a Review Exchange request." },
    { type: "heading", text: "Tags", anchor: "tags" },
    { type: "paragraph", text: "Preset tags are Cheeser, Proxy, All-in, Macro, Smurf, Off-race, Rival and Toxic. Toxic is always private: adding it turns Show on stream off. You can add your own tags of up to 24 characters." },
    { type: "paragraph", text: "Suggested tags come from your games and are never added for you. Cheeser is suggested when at least 40% of the player's labelled openings against you were early all-ins, over at least 3 games." },
    { type: "heading", text: "Follow their other accounts", anchor: "scope" },
    { type: "paragraph", text: "Turn on **All their accounts** to show the note when you meet the same player on a linked account. Links come from approved identities and cached SC2Pulse account links, and follow your Group same player setting. Similar names never link accounts." },
    { type: "paragraph", text: "The account's own note always comes first. On stream, your scouting widget shows that account's own note when it may appear on stream; otherwise the most recently updated on-stream note from a linked account. The dossier and your live brief list linked accounts' notes under From their other accounts." },
    { type: "heading", text: "Export and deletion", anchor: "data" },
    { type: "paragraph", text: "Notes are included in your account export and snapshots, and are deleted when you delete your account." },
  ],
  related: ["opponent-dossier", "live-scouting", "game-page-notes"],
};

export default article;
