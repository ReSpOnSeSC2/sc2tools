import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "install-app",
  title: "Install SC2 Tools: desktop app or web app",
  summary:
    "Install the Windows desktop agent for replay sync and Companion, or add the website to your phone or computer as a web app.",
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
  updated: "2026-10-28",
  body: [
    { type: "callout", tone: "info", title: "Agent 0.24.1 and later", text: "Use the [Windows download](/download) or **Agent → Check for updates** for the latest Companion controls. An existing installation keeps its pairing and settings. See [Desktop Companion](/help/desktop-companion)." },
    { type: "heading", text: "Windows desktop Companion", anchor: "desktop-companion" },
    { type: "paragraph", text: "For replay syncing, [download the current stable Windows agent](/download) and [link your account](/help/install-and-pair). Companion includes an interactive scouting desk, embedded build selectors, Session and Build Order Ghost. These panels work without OBS and have a master assistance switch plus individual controls. Randomize in check-in saves one build even without an open widget; its visuals, sounds and speech stay in the browser or OBS widget. See [Desktop Companion](/help/desktop-companion)." },
    { type: "paragraph", text: "The browser installation below adds the website as a separate app window. It gives you the dashboard on phones and computers; it does not install the Windows replay-sync service or native in-game panels." },
    { type: "heading", text: "Install from inside the app", anchor: "install-in-app" },
    { type: "paragraph", text: "On a phone, open **More → Install app**. On desktop, use **Install app** below the Settings sidebar tabs. A supported browser opens its install prompt, or shows the manual steps below. This row disappears after installation, inside the installed app, or when the browser cannot install it." },
    { type: "heading", text: "What happens offline", anchor: "offline" },
    { type: "paragraph", text: "When you navigate without a connection, **You're offline** explains what happened and offers **Try again**. Games need a connection; the desktop app keeps your replays and uploads them when you're back. Only this self-contained offline page is cached, never your account data, API responses or page responses. OBS overlay and Dock sources keep their normal reconnect behavior." },
    {
      type: "paragraph",
      text: "SC2 Tools works in any browser, and you can also install it like an app. The installed app opens in its own window without the address bar, starts on **Today** or the **Default tab** you chose in Settings, and keeps you signed in. The **Today** shortcut always opens Today. It is the same site with the same data, so there is nothing to sync.",
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
      text: "If you opened the install steps in another iOS browser, open the page in Safari first. Then use **Share → Add to Home Screen**.",
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
      text: "The app updates itself. When a new version is ready, **Update available** appears at the bottom of the screen. **What changed** opens the [changelog](/changelog) without applying the update. **Reload** switches to it now, so save any edits first. **Later** hides the message for this browser session.",
    },
    { type: "heading", text: "Installed it before this update?" },
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
  related: ["desktop-companion", "install-and-pair", "getting-started", "how-to-use-help", "troubleshooting-and-support"],
};

export default article;
