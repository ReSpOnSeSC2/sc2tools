import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "something-went-wrong",
  title: "Something went wrong",
  summary:
    "What it means when a section can't load or the bar at the top says Reconnecting, what Retry does, and what the Error ID is for. Your data is safe either way.",
  category: "troubleshooting",
  audience: "all",
  order: 10,
  keywords: [
    "error",
    "retry",
    "try again",
    "error id",
    "request id",
    "reconnecting",
    "offline",
    "can't reach",
    "server busy",
    "waking up",
    "cold start",
    "not loading",
    "blank",
    "no data",
    "couldn't load",
    "couldn't show",
    "took too long",
    "timeout",
    "503",
    "500",
  ],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools keeps your games, builds and settings on a server. If a section says it couldn't load, use **Retry** to request it again. An empty section by itself does not confirm your filters matched nothing; check for an error or a connection notice too.",
    },
    { type: "heading", text: "What each message means" },
    {
      type: "table",
      head: ["Message", "What happened", "What to do"],
      rows: [
        [
          "Can't reach SC2 Tools",
          "No answer came back. Your connection dropped, or the server is restarting or being updated.",
          "Check your connection, then press **Retry** in a moment.",
        ],
        [
          "The server is busy",
          "A heavy request is already running (an opponent dossier, a big trends chart). The server runs a few at a time.",
          "Wait a moment and press **Retry**.",
        ],
        [
          "This took too long to load",
          "The server didn't answer in time, usually on a very large date range.",
          "Press **Retry**, or narrow the date range.",
        ],
        [
          "You're signed out",
          "Your session ended.",
          "Press **Sign in again**.",
        ],
        [
          "Something went wrong on our side",
          "The server hit an error.",
          "Press **Retry**. If it keeps happening, report it with the Error ID.",
        ],
        [
          "Couldn't show this section",
          "Part of the page failed to draw. The rest of the page still works.",
          "Press **Try again**. If it keeps happening, press **Report this problem**.",
        ],
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Your filters are still applied",
      text: "On analyzer pages the message says so: a failed request doesn't reset your date range, matchup or other filters. Retry asks again with the same filters.",
    },
    { type: "heading", text: "Retry" },
    {
      type: "paragraph",
      text: "**Retry** sends the same request again. The button says *Retrying…* while it waits. If the section loads, the message goes away; if it fails again, the message stays and you can try again in a moment. Sections also retry on their own after a short wait, so a page left open recovers by itself.",
    },
    { type: "heading", text: "Error ID" },
    {
      type: "list",
      items: [
        "When the server answered with an error, the message shows an **Error ID** (for example `1a2b3c4d`). It points to that exact request in our server logs.",
        "Press **Copy** next to it and paste it into your report, so we can see what went wrong without asking you to repeat it.",
        "A section that failed to draw shows its own Error ID under **Details**, and **Report this problem** fills it in for you.",
        "When the request never reached us (no connection), there's no Error ID. Nothing was recorded because nothing arrived.",
      ],
    },
    { type: "heading", text: "Reconnecting to SC2 Tools… your data is safe" },
    {
      type: "paragraph",
      text: "This bar appears under the top bar when your browser is offline, or after a few requests in a row get no answer. Your connection may have dropped, or the server may be restarting or being updated.",
    },
    {
      type: "list",
      items: [
        "**Nothing is lost.** Your games, builds and settings are stored in the database, not in the page. Changes you already saved are kept.",
        "**Games you play meanwhile still arrive.** Your replays stay on your PC and the desktop app keeps retrying the upload until the server answers.",
        "**You don't need to reload.** The page checks every 10 seconds; as soon as the server answers, the bar goes away and the sections that failed load again.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "Unsaved edits",
      text: "Edits you haven't saved yet (a settings form, a build you're writing) stay on the page while it reconnects. Save them once the bar is gone.",
    },
    { type: "heading", text: "Still not working?" },
    {
      type: "steps",
      items: [
        "Wait a minute and press **Retry** once more.",
        "Reload the page. If other sites work but SC2 Tools doesn't, it's on our side.",
        "Report it: copy the Error ID if there is one, and tell us which page and what you clicked.",
      ],
    },
  ],
  related: ["report-a-problem", "troubleshooting-and-support", "how-to-use-help", "dashboard-and-analyzer"],
};

export default article;
