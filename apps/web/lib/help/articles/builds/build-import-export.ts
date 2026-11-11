import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-import-export",
  title: "Back up, import and share builds",
  summary:
    "Export your library to a .json file, import builds from a file, pasted JSON or a share code, and send a build to a friend as a link.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "export", "import", "backup", "json", "share code", "share link", "copy build",
    "transfer builds", "conflict", "overwrite", "save a copy",
  ],
  updated: "2026-11-10",
  body: [
    { type: "heading", text: "Export", anchor: "export" },
    { type: "paragraph", text: "**Export** in your [build library](/builds) downloads every build as a .json file. In selection mode, **Export** downloads only the selected builds. Exports never include Community publishing settings." },
    { type: "heading", text: "Import", anchor: "import" },
    { type: "steps", items: [
      "Choose **Import**, then paste a share code or JSON, or **Choose a .json file** (2 MB at most).",
      "**Preview** checks each build and marks it **New**, already in your library, or **Invalid** with the reason.",
      "For a build you already have, pick **Skip**, **Save a copy** (named “name (copy)”) or **Overwrite** (the replaced version stays in its History).",
      "**Import** saves the builds privately and re-matches your replays once at the end.",
    ] },
    { type: "callout", tone: "info", text: "A library holds up to 500 builds. An import that would go past that is refused before anything is saved." },
    { type: "heading", text: "Share a build", anchor: "share-codes" },
    { type: "paragraph", text: "**Copy share code** in a build's ⋯ menu copies a link to /builds/import. The build travels in the part of the link after #, which browsers never send to a server. The receiver signs in, opens the link and previews the build before importing it. Share codes hold the build's rules, races, description and game plan, never your notes, and must be under 8 KB." },
  ],
  related: ["custom-builds", "build-library", "build-history", "publish-community-builds"],
  order: 23,
};

export default article;
