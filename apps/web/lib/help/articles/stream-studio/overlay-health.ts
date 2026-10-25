import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "overlay-health", title: "Is my overlay ready?", summary: "Check connected sources, recognize older pages and avoid duplicate audio before going live.",
  category: "stream-studio", audience: "streamer", signedInOnly: false, order: 2, updated: "2026-10-25",
  keywords: ["OBS", "overlay", "sources", "ready", "health", "duplicate audio", "agent", "connection"],
  body: [
    { type: "settingsLink", label: "Open Overlay setup", href: "/settings?tab=overlay&section=setup" },
    { type: "steps", items: [
      "Open **Settings → Overlay → Setup** or **Widgets** and find **Ready to go live?**. Leave the section visible while it checks your agent, game source, optional chat and Stream Dock. Checks refresh every 15 seconds while visible; **Refresh sources** requests a new check.",
      "A widget's **In OBS ×N** badge counts connected source pages. **Not added** means no identified source is connected for that widget. An enabled All-in-one source counts for its enabled widgets; Ghost uses its own assigned source. A source page opened in an ordinary browser also counts, so verify the source eye icon and scene in OBS yourself.",
      "**Unknown source** means an older or unidentified page is connected. Refresh older OBS Browser Sources once so they can report which widget they display. The unknown count does not reveal a private URL or identify a particular device.",
      "**Duplicate audio** warns that more than one audio-capable source is connected, for example All-in-one plus Scouting. Keep one speaking copy audible. The check counts possible audio sources; it cannot inspect your OBS mixer or prove that either copy is currently audible.",
      "If Agent is not connected, check **Devices**, restart the desktop app and confirm it is paired. A recent game-update time confirms that replay data reached the overlay feed; before your first game or after an API restart this can be unknown. Chat and the Dock are optional when you only want game cards.",
      "Use the local playground to check a sample privately, then **Test** to verify the actual source in OBS. A successful sample checks rendering; a real game and uploaded replay confirm the live-data path.",
    ] },
    { type: "paragraph", text: "The Stream Dock's source strip shows counts for All-in-one, widgets, scenes, Docks and unknown pages. A refresh failure is shown as unavailable or as a previous check, rather than reporting zero connected sources. Wait a few seconds before retrying if another open page just checked the same overlay." },
    { type: "paragraph", text: "Connection counts do not reveal socket IDs, private source URLs, platform credentials or another owner's sources. This checklist never enables an integration or changes an OBS scene." },
  ], related: ["obs-overlay-setup", "stream-dock", "troubleshooting-and-support"],
};
export default article;
