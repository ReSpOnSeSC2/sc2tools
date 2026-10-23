import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "how-to-use-help",
  title: "How to use Help",
  summary:
    "Search for what you need, open an article right next to the feature you're using, and share a link that opens the exact article.",
  category: "getting-started",
  audience: "all",
  order: 2,
  keywords: ["help", "search", "find", "faq", "docs", "documentation", "guide", "link", "share", "support"],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "Help lives in two places with the same articles: the public [help center](/help), and **Settings → Help** inside the app.",
    },
    { type: "heading", text: "Search" },
    {
      type: "list",
      items: [
        "Type a few words into the search box. Results update as you type.",
        "Use the words you see on screen, like *pairing code*, *Browser Source* or *check-in*. Partial words and small typos still find the article.",
        "Common short forms work too: *OBS* finds overlay articles, *code* finds pairing, *tray* finds the desktop app and *sync* finds uploads.",
      ],
    },
    { type: "heading", text: "Browse" },
    {
      type: "paragraph",
      text: "Articles are grouped by topic, from Getting started to Troubleshooting. The **Popular** list on the help center is a good place to start.",
    },
    { type: "heading", text: "Help next to the feature" },
    {
      type: "paragraph",
      text: "Some screens have a help link next to a setting. It opens the article in a panel at the side of the screen (at the bottom on a phone), so you don't lose your place. Press **Esc** or the close button to go back, or **Open full article** to read it on its own page.",
    },
    { type: "heading", text: "Share a link" },
    {
      type: "list",
      items: [
        "Every article has its own address on the help center, for example `/help/getting-started`.",
        "In the app, add the article name after `#` to open it in Settings → Help, for example `/settings?tab=help#getting-started`.",
      ],
    },
    { type: "heading", text: "Still stuck?" },
    {
      type: "paragraph",
      text: "Help pages end with our support email, and with a **Report a problem** button when you're signed in. Inside the app, the **?** button in the top bar has it too. Tell us what you clicked and add a screenshot if you can; see [Report a problem or suggest a feature](/help/report-a-problem) for what else goes with a report.",
    },
  ],
  related: ["getting-started", "troubleshooting-and-support", "report-a-problem"],
};

export default article;
