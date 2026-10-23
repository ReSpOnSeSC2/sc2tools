import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "publish-community-builds",
  title: "Publish and reuse community builds",
  summary:
    "Share one of your custom builds on the Community page, or save someone else's to your library as a private copy you can edit.",
  category: "builds",
  audience: "player",
  keywords: [
    "community",
    "community builds",
    "publish",
    "share build",
    "unpublish",
    "anonymous",
    "save to my library",
    "copy build",
    "fork",
    "in your library",
    "save another copy",
    "game plan",
    "skill level",
    "mine", "my published builds", "publish picker", "publish update", "private record",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Community](/community) lists custom builds that players chose to share. Anyone can read them; with an account you can vote on them and save them to your own library.",
    },
    { type: "heading", text: "Save a community build to your library" },
    {
      type: "steps",
      items: [
        "Open a build on [Community](/community) and click **Save to my library**. Not signed in? Click **Sign up free to save this build**, or **Sign in** to come straight back to the build.",
        "The copy appears in [your library](/builds) with the build's rules, game plan and skill level. **Saved to your library** confirms it, with an **Open in library** link.",
        "It's a **private copy you can edit**: change its rules, name or notes, and the author's build doesn't change. Your past games are checked against it, so it gets its own record.",
      ],
    },
    {
      type: "paragraph",
      text: "Copies saved since this update are recognised on the community page as **In your library — Open**. Copies saved before this update may not be recognised, so check your library before saving again. Use **Save another copy** when you want a second one to experiment with. Deleting a recognised copy brings the Save button back.",
    },
    { type: "heading", text: "Reading a community build" },
    {
      type: "list",
      items: [
        "**Build order** lists the rules a game must pass: **Must have**, **Must not have** and **Limits**, each with its deadline (*before 4:20*). See [How build rules are counted](/help/rules-explained).",
        "**Game plan** shows the author's win conditions, what the build loses to and what it transitions into, when they wrote any.",
        "The header shows the matchup and, when the author set one, the skill level the build is meant for.",
      ],
    },
    { type: "heading", text: "Publish one of your builds" },
    {
      type: "steps",
      items: [
        "Open the build in [your library](/builds) and click **Publish…**.",
        "Check the public title and description and the name shown with the build. Tick **Post anonymously** to publish it without your name or profile link.",
        "Tick **Public data acknowledged** and click **Publish…**. **View on the community page** opens its public page; **Copy link** copies its public address. If your browser blocks the clipboard, a selected link field lets you copy it yourself.",
      ],
    },
    {
      type: "list",
      items: [
        "**Public:** the title, description, the build's rules or steps, its game plan and skill level, and the author name you chose.",
        "**Private:** your personal notes, the replays the build came from and your opponents.",
        "**Update it** by editing the build in your library and choosing **Update listing**. The public link and its votes stay the same.",
        "**Take it down** with **Unpublish** in the build's **⋯** menu or its Update listing window. Confirm **Unpublish** to remove the Community listing while keeping your private copy, stats and notes. You can also turn off **Share with community** in the editor.",
        "**View on Community** and **Copy public link** in **⋯** use the listing's public address, which can differ from your private library slug. **Delete** removes both your private build and its Community listing.",
        "**Duplicate** in **⋯** makes a separate private variant, including its rules, game plan and your private notes. Saving the copy leaves the original listing unchanged. A **Low sample** badge means fewer than five games matched that private build; its win rate may swing a lot.",
      ],
    },
    { type: "heading", text: "Publish from Community", anchor: "publish-from-community" },
    { type: "steps", items: [
      "Choose **Publish a build** on [Community](/community). If signed out, **Sign in to publish** brings you back to the picker after sign-in.",
      "**Pick a build to publish** shows your saved library builds, most recently updated first. Filter by name or use Next to browse more. A **Published** badge marks an active listing. Choosing it opens its update window; choosing another build opens its publication window.",
      "Check the title, description, author setting and public-data notice before publishing. If your library is empty, **Create a build** opens the editor, and **Learn how** explains saving builds.",
    ] },
    { type: "heading", text: "Named vs anonymous", anchor: "named-vs-anonymous" },
    { type: "paragraph", text: "A named listing links to your public author profile. **Post anonymously** keeps your name and profile link off that listing; anonymous builds never join your author profile. You still see anonymous publications in your own Mine view." },
    { type: "heading", text: "My published builds", anchor: "my-published-builds" },
    { type: "paragraph", text: "While signed in, choose **Mine** on [Community](/community?mine=1). It shows your publications, votes, dates, author setting and private game record. The record is visible only to you and comes from your classified replays, not other players' games or manual check-ins. The percentage counts wins and losses; games without a decided result do not change it. **No games with this build yet** is a verified zero. Mine shows up to your 200 most recently updated publications." },
    { type: "heading", text: "Update or remove", anchor: "update-or-remove" },
    { type: "list", items: [
      "**Edit in library** opens your private source build. **Publish update** opens its current listing for review. The public address and votes stay with that listing after an update.",
      "On a Community card, **Your build options** offers Edit in library, Publish update and Remove from Community. Removal keeps both confirmation steps and leaves your private copy, notes and replay record intact.",
      "Mine labels a listing you took down as **Not published**, and a moderation removal as **Removed by a moderator**. Neither removal deletes your private library build.",
    ] },
  ],
  related: ["custom-builds", "rules-explained"],
  order: 30,
};

export default article;
