import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-notes",
  title: "Game notes & review queue",
  summary:
    "Note a moment of a replay, pin it on the map, and keep a queue of games to review with tags you can filter on the Replays page.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 5,
  keywords: [
    "game notes",
    "timestamp",
    "note at time",
    "pin on map",
    "review queue",
    "to review",
    "reviewed",
    "review tags",
    "has notes",
    "undo delete",
    "shortcut b",
  ],
  updated: "2026-11-10",
  body: [
    { type: "heading", text: "Add a note at a moment", anchor: "add" },
    { type: "steps", items: [
      "Play or scrub the map replay to the moment, then select **Note at 4:12** in the replay controls or press **B**. Playback pauses.",
      "Write what happened and what to do next time. Add tags if you like, then **Save note** (Ctrl+Enter or ⌘+Enter).",
      "To mark where it happened, choose **Pin on map** in the note, then click or tap the replay map.",
    ] },
    { type: "paragraph", text: "**Add note at** and **General note** in the Game notes section do the same from below the replay; a general note has no game time. A game can hold up to 200 notes of up to 500 characters, each with up to 8 tags." },
    { type: "heading", text: "Find your notes again", anchor: "list" },
    { type: "paragraph", text: "Game notes are listed by game time. Select a time to jump the replay there. Notes appear as markers above the replay timeline and as numbered pins on the map around their moment; selecting one jumps to its note. Use the star to mark a key moment, the pencil to edit the text or tags, and the bin to delete. **Undo** right after a delete restores the note." },
    { type: "heading", text: "The review queue", anchor: "review-queue" },
    { type: "paragraph", text: "In the game header, **Mark to review** adds the game to your review queue and **Mark reviewed** records that you went through it. **Review tags** adds up to 5 tags, such as Macro or Build order." },
    { type: "paragraph", text: "On the [Replays](/app/replays) page, filter by **To review** or **Reviewed**, by review tag, or by **Has notes**. Rows show the review state, tags and note count. Search also matches the text of your game notes. Older and Newer on a game page follow the same filters." },
    { type: "heading", text: "Private by design", anchor: "privacy" },
    { type: "paragraph", text: "Game notes and the review queue are visible only to you. They are never part of a shared replay, your public replay archive or a Review Exchange request. Build check-in notes are separate and unchanged." },
    { type: "paragraph", text: "Deleting a game deletes its notes, and deleting game history removes the notes of the deleted games. Notes are included in your account export and snapshots." },
  ],
  related: ["game-page", "game-page-replay", "replays", "opponent-notes"],
};

export default article;
