import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "a-page-asked-me-to-sign-in",
  title: "Which pages are public?",
  summary:
    "What you can use without an account, what needs a free one, and what to do when a page asks you to sign in, can't be found or is temporarily unavailable.",
  category: "getting-started",
  audience: "all",
  order: 3,
  keywords: [
    "sign in",
    "log in",
    "login",
    "account",
    "free",
    "public",
    "private",
    "signed out",
    "without an account",
    "visitor",
    "redirect",
    "page not found",
    "404",
    "temporarily unavailable",
    "custom build link",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Most of SC2 Tools is built from your own replays, so it needs a free account. A lot of the site is open to everyone, though, and never asks you to sign in.",
    },
    { type: "heading", text: "Open to everyone" },
    {
      type: "list",
      items: [
        "The [home page](/) and the [Download](/download) page.",
        "[Stream Studio](/stream-studio) and its [crash course](/stream-studio/learn).",
        "[Community builds](/community), author profiles and public opponent profiles.",
        "[Build definitions](/definitions): how each build is recognised.",
        "Replays and archives a player chose to share with a link.",
        "This help center.",
      ],
    },
    { type: "heading", text: "Needs a free account" },
    {
      type: "list",
      items: [
        "[Today](/app) and the rest of the analyzer: your stats come from your replays.",
        "Your [custom build library](/builds). Signed out, that page explains what custom builds do and lets you create an account.",
        "[Devices](/devices) and the setup wizard, where you pair the desktop app.",
        "[Settings](/settings), including your overlay links for OBS.",
        "Asking for or writing replay reviews, voting, and publishing or saving community builds.",
      ],
    },
    { type: "heading", text: "Why a page asked me to sign in" },
    {
      type: "paragraph",
      text: "You followed a link to one of the account pages above while signed out. Sign in and you land back on the page you wanted; a new account goes through a short setup first.",
    },
    {
      type: "paragraph",
      text: "A link to someone else's custom build only opens for the account that saved it: custom builds are private. Ask them to publish it to [Community builds](/community), where anyone can see it and save a copy.",
    },
    { type: "heading", text: "\"We couldn't find that page\"" },
    {
      type: "paragraph",
      text: "The link is old, or the build or replay it pointed to was removed. Use **Go home**, or one of the pages suggested under it.",
    },
    { type: "heading", text: "\"Temporarily unavailable\"" },
    {
      type: "paragraph",
      text: "A public page couldn't reach our server, which can take about 30 seconds to wake up. Nothing is lost: press **Try again** in a moment. A build or profile that exists is never reported as missing while the server is waking up.",
    },
    {
      type: "callout",
      tone: "info",
      text: "Signing up is free. Your replays, stats, notes and custom builds stay private to your account unless you choose to publish something.",
    },
  ],
  related: ["getting-started", "something-went-wrong", "how-to-use-help", "troubleshooting-and-support"],
};

export default article;
