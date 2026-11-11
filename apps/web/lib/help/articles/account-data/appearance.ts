import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "appearance", title: "Accessibility & appearance",
  summary: "Choose Light, Dark or System, set text size and density, pick how dates, times and weeks look, use keyboard navigation and report an accessibility barrier.",
  category: "account-data", audience: "all", updated: "2026-11-10",
  keywords: ["theme", "light", "dark", "system", "appearance", "keyboard", "contrast", "screen reader", "accessibility", "reduced motion", "text size", "font size", "density", "compact", "24-hour clock", "12-hour clock", "week start", "Monday", "date format", "locale"],
  body: [
    { type: "heading", text: "Choose your appearance", anchor: "theme" },
    { type: "paragraph", text: "Open Appearance in the account menu, or the Theme row in the mobile navigation or More sheet. Choose **Light**, **Dark** or **System**. System follows your device's color preference and updates when that preference changes. The compact theme button switches Light and Dark with one press. Hold it, right-click it or focus it and press **Arrow Down** to open all three choices." },
    { type: "paragraph", text: "The choice is saved in this browser and shared with other tabs. It is not an account preference or an OBS overlay theme. When browser storage is unavailable, the choice still works for the current page. [Overlay setup guide](/help/obs-overlay-setup)." },
    { type: "heading", text: "Motion, text size and density", anchor: "appearance-options" },
    { type: "paragraph", text: "Open [Settings → Preferences → Appearance & region](/settings?tab=preferences#appearance), or choose **More appearance options** in the theme menu. **Text size** offers Default, Large (112.5%) and Larger (125%): text and the spacing around it grow together while the page keeps its layout, unlike browser zoom. **Density** offers Comfortable and Compact; Compact tightens table rows and card padding so more fits on screen. Press **Save** to apply them." },
    { type: "paragraph", text: "**Motion** follows your device in System mode. Choose Reduce motion or Full motion to set it for SC2 Tools." },
    { type: "paragraph", text: "These choices are saved to your account and follow you to every browser you sign in to. Each browser also keeps a copy, so the page opens at your size without a jump, and the choice still applies when you are signed out. OBS overlays and the Stream Dock always keep their broadcast layout." },
    { type: "heading", text: "Dates, times and weeks", anchor: "region-and-formats" },
    { type: "paragraph", text: "**Language and region** sets how dates and numbers are written, for example 10.11.2026 and 1.234 in German or 10/11/2026 in British English. **Automatic** follows this browser's language. The site's wording stays in English." },
    { type: "list", items: ["**Clock**: Automatic follows the language and region; choose 12-hour (2:30 PM) or 24-hour (14:30) to override it.", "**Week starts on**: Automatic follows the region (Sunday in the United States, Monday in most of Europe); choose Monday, Sunday or Saturday. It sets the **Last week** date range and where weekly bars start on Trends.", "The Settings preview shows a sample date, time and number before you save."] },
    { type: "heading", text: "Use the keyboard", anchor: "keyboard" },
    { type: "list", items: ["Press **Tab** or **Shift+Tab** to move between controls. The skip link moves to the main content.", "Use **Enter** for links and **Enter** or **Space** for buttons. In the theme choices, arrow keys select another option; Home and End reach the first and last.", "Supported menus and dialogs close with **Escape** and return focus to the opener. Tab stays inside the open mobile navigation or More sheet. Changing a theme keeps either sheet open; selecting a destination closes it.", "The mobile site menu opens as a right-hand sheet with **Close** first in keyboard order, a home link and your available destinations. It closes when the desktop navigation becomes available.", "Settings → Preferences → Appearance & region enlarges text without zooming; your browser's zoom controls still work too. Your device's reduced-motion setting disables nonessential site animation."] },
    { type: "heading", text: "Limits and feedback", anchor: "barriers" },
    { type: "paragraph", text: "Replay maps, some charts, broadcast overlays and third-party widgets have visual or interaction limits. Read the [accessibility statement](/legal/accessibility) for the current target and known limits. Use Help & support → Report a problem, or its signed-out Email support link, to describe a barrier. Include the page, task, browser and assistive technology; do not include private replay data or access tokens." },
  ],
  related: ["report-a-problem"],
};
export default article;
