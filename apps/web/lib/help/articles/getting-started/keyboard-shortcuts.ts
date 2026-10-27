import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "keyboard-shortcuts",
  title: "Search and keyboard shortcuts",
  summary: "Find pages, settings, Help and public guides from one search box. Use keyboard shortcuts to move around SC2 Tools.",
  category: "getting-started",
  audience: "all",
  order: 4,
  keywords: ["search", "find", "keyboard", "shortcuts", "Ctrl K", "Cmd K", "command palette", "slash", "guides", "recent", "12 pool"],
  updated: "2026-10-27",
  body: [
    { type: "heading", text: "Open Search", anchor: "open-search" },
    { type: "paragraph", text: "Select the magnifying-glass **Search** button in the header. In the app on a phone, open **More → Search**. On a keyboard, press **Ctrl K** on Windows or **⌘ K** on a Mac while you are outside an editing field." },
    { type: "steps", items: [
      "Type a page, setting or topic, such as **Opponents**, **TTS volume**, **supply block** or **Change appearance**.",
      "Use **Up** and **Down** to move through available results, then **Enter** to open one. You can also select a result directly.",
      "Press **Escape** to close Search. If you cancel without opening a result, focus returns to where you opened it.",
    ] },
    { type: "paragraph", text: "Results are grouped into **Pages**, **Settings**, **Help**, **Glossary**, **Build definitions**, **Stream widgets** and **Actions**. Public guide results have **Openers**, **How to beat** and **Maps** groups. The pages and settings offered depend on what is available to your account. Visitors can use public topics and guides without signing in." },
    { type: "paragraph", text: "Setting results open the matching tab or section. If a Settings draft needs attention, the usual **Stay** or **Discard** choice appears before you leave. **Change appearance** opens the appearance chooser; **Pair a device** opens Devices so you can continue there." },
    { type: "heading", text: "Find a guide", anchor: "find-a-guide" },
    { type: "paragraph", text: "On [Guides](/guides) or a matchup guide, type in the visible **Find a guide** field, then select **Search** or press **Enter**. This opens Search with guide results. On a matchup page, the search starts with that matchup." },
    { type: "list", items: [
      "Try **12 pool pvz**, **how to beat 12 pool pvz**, a build name or a map name. Openers are your own build; How to beat describes the opponent's opening.",
      "Your race comes first in a matchup: **PvZ** means Protoss against Zerg; **ZvP** means Zerg against Protoss. You can also type **Protoss vs Zerg**. Include another matchup to change the guide search's starting matchup.",
      "A published guide can be opened. **Not enough games yet** means that guide is not ready to publish; its result stays visible but cannot be opened.",
      "**Guide availability unavailable** means Search could not check which guides are ready. Select **Retry guide availability** to check again. The other Search groups remain usable.",
    ] },
    { type: "heading", text: "Keyboard reference", anchor: "keyboard-reference" },
    { type: "table", head: ["Key", "What it does"], rows: [
      ["Ctrl K / ⌘ K", "Open Search outside an editing field."],
      ["/", "Focus the page's visible search field when it has one, such as Find a setting, the Builds filter or Find a guide. Otherwise open Search."],
      ["?", "Open Keyboard shortcuts outside an editing field. The replay player keeps its own help when you are using the player."],
      ["g, then t", "Open Today when it is available in your navigation."],
      ["g, then o", "Open Opponents when it is available in your navigation."],
      ["g, then r", "Open Reviews when it is available in your navigation."],
      ["g, then s", "Open Settings when it is available in your navigation."],
      ["Up / Down, then Enter", "Choose and open an available result while Search is open."],
      ["Escape", "Close Search."],
    ] },
    { type: "paragraph", text: "For a two-key shortcut, release **g**, then press the next key within a second. These shortcuts wait while you are typing or using another dialog or menu. Inside Search, a typed **?** stays part of your query; use the **Keyboard shortcuts** button to open the reference." },
    { type: "heading", text: "Recent pages and your search words", anchor: "recent-and-privacy" },
    { type: "paragraph", text: "With an empty search box, **Recent** can show up to eight app pages visited by your signed-in account in this browser. Another account does not see your Recent list, and signing out clears it. Search words are not saved. Searching uses page names, setting labels and public reference information; it does not read the values in your Settings forms." },
    { type: "settingsLink", label: "Browse Guides", href: "/guides" },
  ],
  related: ["settings-overview", "how-to-use-help", "build-guides", "getting-started"],
};

export default article;
