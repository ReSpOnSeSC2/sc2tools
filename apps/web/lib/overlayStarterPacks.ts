export const OVERLAY_STARTER_PACKS = [
  { id: "first-stream", name: "Your first stream", goal: "A clean scoreboard and context for every game.", widgets: [
    { id: "session", name: "Session record", why: "Keep the day's story on screen." },
    { id: "opponent", name: "Opponent identity", why: "Introduce who you're facing." },
    { id: "match-result", name: "Match result", why: "Let viewers catch the outcome." },
  ] },
  { id: "practice", name: "A practice night", goal: "Make the plan visible, then put it into practice.", widgets: [
    { id: "ghost-build", name: "Ghost Build coach", why: "Choose and assign a timed build before copying its URL.", urlArmed: true },
    { id: "randomizer", name: "Build randomizer", why: "Choose an opening from your own pool." },
    { id: "scouting", name: "Scouting tells", why: "Learn what to watch for from the opponent." },
  ] },
  { id: "community", name: "A community night", goal: "Bring the conversation into the broadcast.", widgets: [
    { id: "multichat", name: "Multi-platform chat", why: "Show the conversation in one place." },
    { id: "chat-highlight", name: "Chat highlight", why: "Put a great question on screen." },
    { id: "chat-poll", name: "Chat poll", why: "Give viewers a decision to make." },
  ] },
] as const;
export function overlayStarterPack(id: string | null | undefined) { return OVERLAY_STARTER_PACKS.find(pack => pack.id === id); }
