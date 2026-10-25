import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "battle-reports",
  title: "Battle reports",
  summary: "Read a short account of a game, choose a writing tone, revisit captioned moments and copy the report with replay timestamps.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 4,
  updated: "2026-10-25",
  keywords: ["battle report", "story", "caster", "tactical", "snapshots", "copy report", "Markdown", "match recap", "turning point"],
  body: [
    { type: "paragraph", text: "Open a game from [Replays](/app/replays) or an opponent's dossier, then find Battle report near the top of its game page. It turns that replay's recorded events into one to four paragraphs, with captioned moments between them." },
    { type: "heading", text: "How this is written", anchor: "how-written" },
    { type: "paragraph", text: "Reports use fixed rules and a library of sentence patterns, never AI. The same game and recorded data produce the same account in each tone. Names appear as recorded in the replay. Missing details are omitted, and estimated fight windows are identified as estimates." },
    { type: "list", items: [
      "The setting names the map, matchup, players and recorded opening information. A confirmed build check-in is kept separate from the replay's classification.",
      "The opening can describe measured build timings and the first recorded casualty cluster. The middle follows sampled lead changes and larger recorded fights when available.",
      "The closing account includes the recorded result and useful worker or macro observations. A sampled lead change or macro penalty gives context; it does not prove what caused the result.",
      "Games with fewer recorded details receive shorter reports. Loading details shows a status and keeps copying unavailable until that load finishes.",
    ] },
    { type: "heading", text: "Choose a tone", anchor: "tones" },
    { type: "list", items: [
      "Battle report is the default field-report voice.",
      "Caster uses a play-by-play introduction to the same observations.",
      "Tactical uses a concise assessment style. Changing tone changes the wording, while the underlying facts stay the same.",
    ] },
    { type: "heading", text: "Revisit a moment", anchor: "moments" },
    { type: "paragraph", text: "Select a timestamp in the text or a snapshot to seek the page's shared replay clock. It pauses and reveals the replay at that moment. Facts without an embedded time have a small watch-time link. Several moments may describe the same passage of play, so the report avoids repeating nearly identical frames." },
    { type: "paragraph", text: "Map snapshots reuse available complete playback data and the replay's map renderer. Units appear as dots and structures as squares in each side's race color. Your markers are solid and your opponent's are outlined, including in mirror matchups. The legend names both sides and races. A marker identifies a recorded fight location when known. Older replay positions may be approximate. The caption states this." },
    { type: "paragraph", text: "When a map frame is unavailable, the snapshot shows recorded army-value samples around that moment. Missing samples stay gaps. Some recordings are viewed through the replay's timeline instead; select the moment to open it there. Games without nearby army samples show a plain unavailable message. Map data can be synced by the desktop app; see [Map replay](/help/game-page-replay)." },
    { type: "heading", text: "Copy the report", anchor: "copy" },
    { type: "list", items: [
      "Copy text copies the headline, dateline, paragraphs and time references as plain text.",
      "Copy Markdown adds a Markdown heading and timestamp links back to this game. Opening those links still requires access to the game.",
      "If clipboard access is unavailable, the report appears in a selected text field so you can copy it yourself.",
    ] },
  ],
  related: ["game-page", "game-page-replay", "reading-the-charts"],
};

export default article;
