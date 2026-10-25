import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "obs-auto-scene-switching",
  title: "OBS auto scene switching",
  summary:
    "Let the desktop app switch OBS to your gameplay scene when a game loads and back to your between-games scene when you leave it, and build both scenes in one click.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 6,
  keywords: [
    "scene switching",
    "auto scene switch",
    "switch scenes automatically",
    "websocket",
    "websocket server",
    "port 4455",
    "password",
    "test connection",
    "build my scenes",
    "update my scenes",
    "between games",
    "in game",
    "two pc",
    "dual pc",
    "replays",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "The desktop app knows when a game is loading, running or over, so it can switch OBS scenes for you: the gameplay scene as soon as a game loads, and your between-games scene when you're back in the menus. It only changes which scene is live; it never edits your scenes unless you ask it to build them.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "steps",
      items: [
        "In OBS, open **Tools → WebSocket Server Settings**, tick **Enable WebSocket server** and note the port (4455) and password (**Show Connect Info**). It comes with OBS 28 and later.",
        "In the desktop app, open **Settings**, go to **OBS scene switching** and tick **Switch scenes automatically while I play**.",
        "Leave **OBS host** as 127.0.0.1, check the **Port**, paste the **Password** and press **Test connection**.",
        "Choose a scene for each stage of a game, or press **Build my scenes…** to create them (below).",
        "Press **Save settings**.",
      ],
    },
    { type: "heading", text: "Which scene when", anchor: "phases" },
    {
      type: "table",
      head: ["Stage", "Typical scene"],
      rows: [
        ["In the menu / queueing", "Between games"],
        ["Match loading, started, in progress", "In game. The switch happens as the game loads, before the map appears."],
        ["Match ended (score screen)", "Stays on In game, so viewers see the score screen."],
        ["StarCraft II closed", "Between games"],
      ],
    },
    {
      type: "list",
      items: [
        "Every row is optional: leave it on *don't switch* and the scene stays as it is for that stage.",
        "**Wait before leaving a match** (3 seconds by default) stops an alt-tab or a dropped connection from switching away mid-game. Going into a game is never delayed.",
        "Switching a scene by hand pauses automatic switching until the next stage of the game.",
        "Watching replays doesn't switch scenes unless you tick **Also switch when I watch a replay**.",
      ],
    },
    { type: "heading", text: "Build the scenes for you", anchor: "build-scenes" },
    {
      type: "paragraph",
      text: "**Build my scenes…** creates two scenes from the sources you already have: *SC2 Tools — Between Games*, with a big camera, your chat, session stats and a small game view, and *SC2 Tools — In Game*, with the game full screen and a small camera. Pick your webcam and game capture and confirm. They're ordinary OBS scenes, so edit them as you like afterwards; **Update my scenes** later keeps your changes. Starting Soon and BRB from the [Stream Dock](/help/stream-dock) still show on top of both.",
    },
    {
      type: "paragraph",
      text: "The **During games** checklist starts with **All-in-one overlay** on. Ghost Build coach, Build randomizer and the 1920 × 56 scene ticker are optional. The all-in-one source fills your canvas above the webcam and below the Stream Dock cover and alerts. Choose whether it shows SC2 Tools credit. **Update** only adds missing selected sources; it keeps existing sources, settings and relative order. A matching source is reused rather than starting another audio connection. Unchecking an item does not remove a source already in OBS.",
    },
    { type: "heading", text: "Add a widget from the website", anchor: "website-add" },
    {
      type: "steps",
      items: [
        "In an updated, paired desktop app, save your OBS connection details and turn on **Allow website requests to add an OBS source**. This is off by default; automatic scene switching can remain off.",
        "In **Settings → Overlay → Widgets**, enable the widget and choose **Add to OBS**. If several opted-in agents are online, choose one first. An offline or older agent leaves the button disabled with a reason.",
        "On that desktop, read **Add [widget] to scene [name]?**. Cancel is selected by default. Choose **Add source** only when the current program scene is the scene you want; the new source can appear on your live stream.",
        "Read the website result and inspect OBS. A matching source already in that scene is left alone. If the scene changed, the request expired or no acknowledgement arrived, inspect OBS before trying again. Requests are never retried automatically.",
      ],
    },
    {
      type: "paragraph",
      text: "Website Add uses the paired account's default overlay URL and recommended standalone size (the standalone Stats ticker is 1920 × 180). For a particular token, theme or Ghost Build URL configuration, use **Copy** or **Drag into OBS** instead. OBS passwords and overlay URLs are never sent in the website request.",
    },
    { type: "heading", text: "Two PCs", anchor: "two-pcs" },
    {
      type: "paragraph",
      text: "Run the desktop app on the gaming PC, where StarCraft II runs. Set **OBS host** to the stream PC's network address, and allow port 4455 through the stream PC's firewall.",
    },
    { type: "heading", text: "If it doesn't switch", anchor: "troubleshooting" },
    {
      type: "list",
      items: [
        "Press **Test connection**. A wrong password or a closed OBS shows there; OBS must be open before the app can connect.",
        "A scene marked *(missing)* in a dropdown was renamed or deleted in OBS. Pick it again.",
        "Make sure the desktop app is running and StarCraft II is open on the same PC.",
      ],
    },
    {
      type: "settingsLink",
      label: "Stream Studio crash course: build your first scene",
      href: "/stream-studio/learn#crash-course",
    },
  ],
  related: ["obs-overlay-setup", "stream-dock", "desktop-app-overview"],
};

export default article;
