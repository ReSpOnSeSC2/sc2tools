import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "player-channels",
  title: "Link your Twitch and YouTube channels",
  summary:
    "Connect your Twitch and YouTube channels to your StarCraft II accounts so other players can find your stream, and so your games link to the moment in your recordings.",
  category: "account-data",
  audience: "streamer",
  signedInOnly: true,
  order: 50,
  keywords: [
    "twitch",
    "youtube",
    "channel",
    "channels",
    "stream link",
    "vod",
    "recording",
    "pov",
    "watch",
    "player channels",
    "pending review",
    "disconnect",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Linking your channels does two things. Players who face you see your Twitch and YouTube links in their opponent list and at the top of their dossier on you. And when a game you played was streamed, the game shows a link that opens the recording at the moment the game started, for you and for your opponent.",
    },
    { type: "heading", text: "Connect your channels", anchor: "connect" },
    {
      type: "steps",
      items: [
        "Open [Settings → Profile](/settings?tab=profile). Your SC2Pulse IDs or toons must be saved there first: they tell us which StarCraft II accounts are yours.",
        "Under **Twitch & YouTube**, choose which of your accounts the channels are for in **Connect channels for**. Pick all of them to use the same channels everywhere.",
        "Paste your **Twitch channel URL** and your **YouTube channel URL** (a channel or @handle address). Leave one blank if you don't use it.",
        "Press **Save channels**. They show as **Pending review** until an administrator approves them; then everyone can see them.",
      ],
    },
    {
      type: "paragraph",
      text: "Only connect channels that belong to you. The review step exists because anyone could type any channel; links you had approved before stay public while a change is reviewed.",
    },
    { type: "heading", text: "Links to the moment in a recording", anchor: "recordings" },
    {
      type: "list",
      items: [
        "A game only gets a watch link when a recording that covers its time is found on a linked channel. Having a channel linked isn't enough on its own.",
        "The link opens the recording at the game's start. You'll find these links in the game header and in the **Streams** column of [Replays](/app/replays).",
        "Your opponent's recordings show too, when their channel is linked.",
      ],
    },
    { type: "heading", text: "Change or remove them", anchor: "disconnect" },
    {
      type: "paragraph",
      text: "Edit the addresses and press **Save channels** again; changes are reviewed like new links. **Disconnect** removes your links for everyone straight away. Clearing both fields and saving does the same.",
    },
  ],
  related: ["public-profile", "replays", "opponent-dossier"],
};

export default article;
