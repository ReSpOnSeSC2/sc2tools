import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "overlay-url-leaked", title: "My overlay URL leaked", summary: "Replace a private overlay URL while keeping its Studio, viewer XP and predictions.",
  category: "stream-studio", audience: "streamer", signedInOnly: false, order: 3, updated: "2026-10-25",
  keywords: ["rotate", "token", "leaked", "private URL", "revoke", "OBS", "viewer XP", "oracle", "multiple tokens"],
  body: [
    { type: "settingsLink", label: "Manage overlay tokens", href: "/settings?tab=overlay&section=tokens" },
    { type: "steps", items: [
      "Open **Settings → Overlay → Tokens**. Use **URLs shown for** to select the token whose URL leaked. Changing the selector changes every widget, scene, All-in-one and Dock URL shown in Overlay settings. Check the label and short identifier so you replace the correct token.",
      "Choose **Rotate**, read the checklist and confirm **Rotate and preserve data**. The replacement keeps the label, enabled widgets, saved profile, Studio controls, goals, poll, b-roll, viewer XP, oracle scores, predictions and clip moments. Account-owned sounds and alert media references keep working.",
      "The old source connections are retired as soon as rotation starts. Their pages show **This overlay URL was replaced — update it in OBS**. They never receive the replacement credential. A large history may take more than one step: choose **Continue rotation** until the saved-data move finishes. Retry the same operation after a timeout; it resumes the reserved replacement rather than minting another one.",
      "Copy the replacement URLs into your OBS Browser Sources and custom Dock. A connected desktop app with **OBS scene switching enabled** can repair recognized generated Between Games and In Game sources on its next configuration fetch. It follows the exact owned replacement chain, including while it was offline. It preserves source settings, positions and URL query options. Custom sources, custom scenes and Dock URLs need a manual update.",
      "Use **Test** and **Ready to go live?** to check the replacement. Keep URLs private: anyone who holds an active overlay URL can access its overlay data. Rotation never enables an integration, turns on OBS switching or creates a new source.",
    ] },
    { type: "heading", text: "Several tokens" },
    { type: "paragraph", text: "Use **Mint another token** for a separate test or shared setup. Each token has its own URLs, widget selection, profile and Studio. Select it with **URLs shown for**, then edit its label inline with **Save label**. Renaming changes its label without changing its credential." },
    { type: "callout", tone: "warning", title: "Revoke does not move your data", text: "**Revoke** permanently disables a token's URLs. Its viewer XP and oracle scores stay with that revoked token and are lost to a new token. Choose **Rotate** when you need replacement URLs and want to keep the saved data. Restoring an older account snapshot does not revive a revoked or replaced token." },
    { type: "paragraph", text: "Automatic repair is conservative. If OBS is unavailable, switching is disabled, the generated layout cannot be recognized, or a replacement chain is unavailable, copy the current URL manually. The app never chooses an unrelated active token as a replacement. External URLs you pasted yourself remain your responsibility; uploaded sound IDs are served through the new token automatically." },
  ], related: ["obs-overlay-setup", "overlay-health", "stream-dock", "backups-and-export"],
};
export default article;
