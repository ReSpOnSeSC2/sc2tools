import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "build-order-paste", title: "Write or paste a build order", category: "builds", audience: "player", updated: "2026-10-25",
  summary: "Keep a timed or supply-only practice plan separately from the rules that classify your replays.",
  keywords: ["paste", "reference", "build order", "Spawning Tool", "Liquipedia", "supply", "timing", "import", "export"],
  related: ["custom-builds", "build-orders-export"],
  body: [
    { type: "paragraph", text: "Open **Builds → New build → From a pasted build order**, or choose **Build order → Paste order** inside the rich build editor. Pasting creates a private draft. It does not save or publish anything until you choose Save." },
    { type: "heading", text: "Supported formats", anchor: "formats" },
    { type: "list", items: ["Bracketed clock: `[0:18] Pylon`.", "Spawning Tool columns: `13 0:18 Pylon` (supply, time, action).", "Liquipedia supply only: `14 - Pylon`.", "Plain clock: `0:18 Pylon`."] },
    { type: "paragraph", text: "Use one action per nonempty line, up to 120 lines. The preview reports each invalid line. Fix errors before importing; no partial order is silently imported. Known action names become canonical tokens. Unknown actions stay as reference text with a warning and can still be saved." },
    { type: "paragraph", text: "Supply-only lines keep an unknown time, shown as —. SC2 Tools never invents a clock from supply. A supplied 0:00 is different from an unknown time. Supply may be left blank. ≈ marks approximate supply from the latest recorded game sample before an event." },
    { type: "heading", text: "Edit the reference plan", anchor: "edit" },
    { type: "list", items: ["The **Build order** tab has editable m:ss, supply, action and shareable step-note fields. Choose actions with the same keyboard token picker as match rules. Unknown reference text remains allowed.", "Use **Add reference step**, Insert, Delete, drag a row, or the accessible Move up / Move down buttons. Exports keep the authored row order.", "**Trim to first 5:00** removes later timed rows and retains untimed rows. **Collapse repeated army units** combines adjacent identical army rows without notes, keeping the first clock and an instruction with the count and last clock.", "Builds created from a game are filled from its recorded events. Worker rows are folded into supply, and missing supply stays unknown. **Fill from source game** explicitly reloads only that build's source replay when available; it replaces the current reference plan."] },
    { type: "heading", text: "Rules, sharing and practice", anchor: "practice" },
    { type: "paragraph", text: "**Match rules** decide which replays match your build. The reference plan never changes those rules. You may save a reference-only build without any classifier rules; it will not automatically match replays. Save & re-match requires a matching definition when creating a new build." },
    { type: "paragraph", text: "Publishing shares reference actions and step instructions. Your personal build notes and source replay ID remain private. Saving a Community build keeps a private copy of its reference plan." },
    { type: "paragraph", text: "**Practice this** prefers usable supplied reference steps. Enter upgrade completion clocks for practice. Source-game fill keeps recorded upgrade completion; if missing it leaves the clock unknown. Recorded upgrade start and start supply stay in a step note, so start supply is never presented as completion supply. Only known actions with supplied valid clocks become practice checkpoints; untimed or unknown actions stay in your displayed plan. Approximate supply is omitted from exact HUD supply targets. When no usable timed reference steps exist, the existing saved-reference, guide, source replay and rule-checkpoint choices remain available." },
    { type: "heading", text: "Copy or download", anchor: "export" },
    { type: "paragraph", text: "The build's **⋯** actions copy its reference plan as text or a Markdown table, or download a .txt file. Times, supply, approximation labels and shareable step notes are retained; private source replay IDs are excluded. Clipboard fallback provides selectable text. These exports are prepared in your browser." },
  ],
};
export default article;
