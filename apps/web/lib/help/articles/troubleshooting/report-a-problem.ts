import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "report-a-problem",
  title: "Report a problem or suggest a feature",
  summary:
    "Send a problem, an idea or a question straight to the SC2 Tools team, see exactly what goes with it, and untick anything you'd rather not send.",
  category: "troubleshooting",
  audience: "all",
  signedInOnly: true,
  // After "Troubleshooting & support": try the quick fixes first.
  order: 110,
  keywords: [
    "report",
    "bug",
    "bug report",
    "feedback",
    "feature request",
    "idea",
    "suggestion",
    "question",
    "contact",
    "diagnostics",
    "error reference",
    "privacy",
    "what is sent",
  ],
  updated: "2026-10-22",
  body: [
    { type: "heading", text: "Open the form" },
    {
      type: "list",
      items: [
        "Inside the app on desktop, press **Help & support** (the life-buoy icon) in the top bar, then **Report a problem** or **Suggest a feature**.",
        "Inside the app on a phone, tap **More** in the bottom bar and scroll down to **Help & support**.",
        "Inside the app, your avatar menu has **Report a problem** too, and so does **Settings → Help**. On a help page, use **Report a problem** at the end of the article.",
        "If a page breaks, the error screen has a **Report this problem** button. It fills in the page and the error reference for you.",
      ],
    },
    {
      type: "paragraph",
      text: "Choose **Problem**, **Idea** or **Question** at the top, then add a short subject and the details.",
    },
    {
      type: "callout",
      tone: "info",
      title: "These might help",
      text: "As you type the subject, matching help articles appear under it. Open one to read it beside the form; your draft stays where it is.",
    },
    { type: "heading", text: "What goes with your report" },
    {
      type: "paragraph",
      text: "Open **Included with your report** under the details to see everything that is attached:",
    },
    {
      type: "table",
      head: ["Item", "What we see", "Why it helps"],
      rows: [
        ["Page", "The page you were on, without anything after the ? in its address", "Where to look"],
        ["Site version", "Which update of the site you had loaded", "Tells us if a fix has already shipped"],
        ["Browser", "Browser, version and operating system, e.g. Chrome 129 on Windows", "Some problems only happen in one browser"],
        ["Window size", "The size of your browser window, e.g. 1440 × 900", "Layout problems depend on it"],
        ["Desktop app", "The desktop app's version and whether it's online, or Not paired", "Upload problems usually start there"],
        [
          "Recent errors",
          "Up to 5 requests to our servers that failed in this tab, with their error code and reference",
          "Lets us find the exact failure in our logs",
        ],
      ],
    },
    {
      type: "paragraph",
      text: "Overlay links, pairing codes and other keys are removed from every address before it is attached. Your account email is included so admins can identify your report. Replies appear in My reports and your notification inbox.",
    },
    { type: "heading", text: "Remove something" },
    {
      type: "steps",
      items: [
        "Open **Included with your report**.",
        "Untick anything you'd rather not send. The count next to the heading shows how many items are still included.",
        "Press **Send report** (or **Send idea**, **Send question**). Only the ticked items go with it.",
      ],
    },
    { type: "heading", text: "What happens next" },
    {
      type: "list",
      items: [
        "Your report goes straight to the SC2 Tools team's inbox, and we read every one.",
        "Open [Settings → Help → My reports](/settings?tab=help#my-reports) to see your latest 20 reports and any replies. A notification lets you know when an admin answers or changes the status.",
        "After sending, press **Send another** to start a fresh report, or **Close**.",
        "You can send 5 reports every 10 minutes. If you reach the limit, wait a few minutes and try again.",
      ],
    },
    { type: "heading", text: "My reports", anchor: "my-reports" },
    { type: "paragraph", text: "Each report shows **New**, **Looking into it**, **Fixed** or **Won't fix**. Open it to read your original message and replies from SC2 Tools. If you mute report notifications in [Settings → Misc](/settings?tab=misc), replies still appear in My reports. The notification inbox keeps updates for 90 days; My reports lists your latest 20 reports." },
    { type: "heading", text: "Not signed in?" },
    {
      type: "paragraph",
      text: "The form needs an account so we know who to reply to. Email [responsecoaching@gmail.com](mailto:responsecoaching@gmail.com) instead: say what you clicked, add the error reference if you saw one, and attach a screenshot if you can.",
    },
  ],
  related: ["something-went-wrong", "troubleshooting-and-support", "how-to-use-help"],
};

export default article;
