import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "install-app",
  title: "Install SC2 Tools as an app",
  summary:
    "Add SC2 Tools to your phone's home screen or your computer's apps. It opens on Today in its own window, with shortcuts to Opponents, Replays and Stream settings.",
  category: "getting-started",
  audience: "all",
  order: 3,
  keywords: [
    "install",
    "app",
    "pwa",
    "home screen",
    "add to home screen",
    "shortcut",
    "shortcuts",
    "iphone",
    "ipad",
    "android",
    "phone",
    "mobile",
    "taskbar",
    "window",
    "update available",
    "reload",
    "later",
    "uninstall",
  ],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools works in any browser, and you can also install it like an app. The installed app opens in its own window without the address bar, starts on **Today** and keeps you signed in. It is the same site with the same data, so there is nothing to sync.",
    },
    {
      type: "callout",
      tone: "info",
      text: "This is not the desktop app that uploads your replays. To set that up, see [Getting started](/help/getting-started).",
    },
    { type: "heading", text: "On Android" },
    {
      type: "steps",
      items: [
        "Open SC2 Tools in Chrome.",
        "Tap **Install app** on the banner on the home page, or open Chrome's **⋮** menu and tap **Install app** (on some phones it says **Add to Home screen**).",
        "Confirm. SC2 Tools appears on your home screen and in your app list.",
      ],
    },
    { type: "heading", text: "On iPhone or iPad" },
    {
      type: "steps",
      items: [
        "Open SC2 Tools in Safari.",
        "Tap **Share** (the square with an arrow pointing up).",
        "Scroll down, tap **Add to Home Screen**, then tap **Add**.",
      ],
    },
    {
      type: "paragraph",
      text: "On iOS 16.4 and later you can also do this from the Share menu in other browsers, such as Chrome.",
    },
    { type: "heading", text: "On a computer" },
    {
      type: "steps",
      items: [
        "Open SC2 Tools in Chrome or Microsoft Edge.",
        "Click the install icon at the right end of the address bar, or choose **Install** in the browser's menu.",
        "SC2 Tools opens in its own window. Pin it to your taskbar or Dock like any other app.",
      ],
    },
    { type: "heading", text: "Shortcuts" },
    {
      type: "paragraph",
      text: "The installed app has four shortcuts: **Today**, **Opponents**, **Replays** and **Stream settings** (your overlay links for OBS).",
    },
    {
      type: "list",
      items: [
        "**Android:** touch and hold the SC2 Tools icon.",
        "**Windows:** right-click SC2 Tools in the taskbar or the Start menu.",
        "iPhone and iPad don't show shortcuts for apps added from the browser.",
      ],
    },
    { type: "heading", text: "Updates" },
    {
      type: "paragraph",
      text: "The app updates itself. When a new version is ready, **Update available** appears at the bottom of the screen. **Reload** switches to it now, so save any edits first. **Later** hides the message until you next open SC2 Tools.",
    },
    { type: "heading", text: "Installed it before October 2026?" },
    {
      type: "paragraph",
      text: "Older installs open on the home page and have no shortcuts. Remove SC2 Tools from your device and install it again to get them. Your account and data are not affected.",
    },
    { type: "heading", text: "Remove the app" },
    {
      type: "paragraph",
      text: "Remove it like any other app on your device. Your account, replays and settings stay on SC2 Tools; only the shortcut to it goes away.",
    },
  ],
  related: ["getting-started", "how-to-use-help", "troubleshooting-and-support"],
};

export default article;
