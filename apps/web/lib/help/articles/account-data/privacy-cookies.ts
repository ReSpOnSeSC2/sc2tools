import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "privacy-cookies", title: "Privacy & cookies", summary: "Choose whether this browser uses Google Analytics, and change your choice any time.", category: "account-data", audience: "all", keywords: ["privacy", "cookies", "analytics", "consent", "tracking"], updated: "2026-10-23", related: [],
  body: [
    { type: "paragraph", text: "The cookie banner controls **Google Analytics only**. Essential cookies keep you signed in and count each browser once in players online. Rejecting analytics does not turn off the app's features." },
    { type: "paragraph", text: "Account setup milestones and support records are first-party service data, separate from optional Google Analytics. The [Privacy Policy](/legal/privacy) describes their scope and retention. Account deletion anonymizes account identifiers in retained admin audit records." },
    { type: "heading", text: "Change your choice" },
    { type: "steps", items: ["Choose **Cookie settings** in the site footer, or in the [Privacy Policy Cookies section](/legal/privacy#cookies).", "Press **Turn off analytics** or **Allow analytics**. The choice takes effect immediately for this browser.", "Inside the app, you can also open [Settings → Misc](/settings?tab=misc) and use the **Analytics cookies** row."] },
    { type: "paragraph", text: "If your browser blocks site data, your choice still works for this visit, but cannot be remembered after you leave. You will be asked again each visit." },
  ],
};
export default article;
