import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "appearance", title: "Accessibility & appearance",
  summary: "Choose Light, Dark or System, use keyboard navigation and report an accessibility barrier.",
  category: "account-data", audience: "all", updated: "2026-10-25",
  keywords: ["theme", "light", "dark", "system", "appearance", "keyboard", "contrast", "screen reader", "accessibility", "reduced motion"],
  body: [
    { type: "heading", text: "Choose your appearance", anchor: "theme" },
    { type: "paragraph", text: "Open Appearance in the account menu, or the Theme row in the mobile navigation or More sheet. Choose **Light**, **Dark** or **System**. System follows your device's colour preference and updates when that preference changes. The compact theme button switches Light and Dark with one press. Hold it, right-click it or focus it and press **Arrow Down** to open all three choices." },
    { type: "paragraph", text: "The choice is saved in this browser and shared with other tabs. It is not an account preference or an OBS overlay theme. When browser storage is unavailable, the choice still works for the current page. [Overlay setup guide](/help/obs-overlay-setup)." },
    { type: "heading", text: "Use the keyboard", anchor: "keyboard" },
    { type: "list", items: ["Press **Tab** or **Shift+Tab** to move between controls. The skip link moves to the main content.", "Use **Enter** for links and **Enter** or **Space** for buttons. In the theme choices, arrow keys select another option; Home and End reach the first and last.", "Supported menus and dialogs close with **Escape** and return focus to the opener. Tab stays inside the open mobile navigation.", "Your browser's zoom controls can enlarge text. Your device's reduced-motion setting disables nonessential site animation."] },
    { type: "heading", text: "Limits and feedback", anchor: "barriers" },
    { type: "paragraph", text: "Replay maps, some charts, broadcast overlays and third-party widgets have visual or interaction limits. Read the [accessibility statement](/legal/accessibility) for the current target and known limits. Use Help & support → Report a problem, or its signed-out Email support link, to describe a barrier. Include the page, task, browser and assistive technology; do not include private replay data or access tokens." },
  ],
  related: ["report-a-problem"],
};
export default article;
