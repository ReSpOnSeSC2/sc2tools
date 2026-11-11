import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "notifications-on-your-phone", title: "Notifications on your phone",
  summary: "Get review answers, coaching bookings and reminders, playback-ready alerts and your weekly report on your phone or desktop, even with SC2 Tools closed. Add coaching sessions to your calendar.",
  category: "account-data", audience: "all", signedInOnly: true, order: 26, updated: "2026-11-10",
  keywords: ["push notifications", "phone notifications", "web push", "iphone", "android", "calendar", "ics", "coaching reminders", "google calendar"],
  body: [
    { type: "heading", text: "Turn on notifications for a device", anchor: "turn-on" },
    { type: "steps", items: [
      "On the phone or computer you want to notify, open [Settings → Preferences](/settings?tab=preferences#push) and find **Phone and browser notifications**.",
      "Press **Turn on for this device** and allow notifications when the browser asks.",
      "Choose **What to push**, then press **Send a test** to check it arrives.",
    ] },
    { type: "callout", tone: "info", title: "iPhone and iPad", text: "Apple only allows notifications for sites added to the Home Screen. In Safari, press **Share → Add to Home Screen**, open SC2 Tools from that icon, sign in, then turn notifications on there (iOS 16.4 or later)." },
    { type: "paragraph", text: "Each browser and phone is turned on separately. The **Devices** list shows every device that receives your notifications; **Remove** stops one, and **Turn off for this device** stops the one you are using. Muting a kind of notification in [Notifications](/help/notifications) also stops it on your devices." },
    { type: "heading", text: "What can be pushed", anchor: "kinds" },
    { type: "list", items: [
      "**Review answers** and **New reviews** can be selected separately.",
      "**Coaching bookings and assignments** covers bookings, cancellations and assignments. **Coaching reminders** arrive 24 hours and 1 hour before a session.",
      "**Accurate playback ready:** when a replay's full-accuracy playback has finished preparing.",
      "**Weekly report** and **Stream reports** let you choose either recap.",
      "**Goal met** is sent when you complete a goal.",
      "**Desktop app unlinked** is sent when a connected desktop app is removed from Devices.",
      "**Desktop app updates and integrations** covers required updates and Discord delivery failures.",
      "**Everything else:** import results, report replies and other updates. Off unless you tick it.",
    ] },
    { type: "paragraph", text: "Notifications travel through your browser's own free push service, encrypted so only your device can read them. If push isn't switched on for SC2 Tools yet, the section says so and the bell keeps working as before." },
    { type: "heading", text: "Add coaching sessions to your calendar", anchor: "calendar" },
    { type: "paragraph", text: "On the [Coaching](/coaching) sessions tab, every booked session has **Add to calendar**, which saves a calendar file for that one session. To keep your calendar up to date automatically, press **Create calendar link** under **Add sessions to your calendar**, copy the link, and subscribe to it in Google Calendar (Other calendars → From URL), Apple Calendar or Outlook." },
    { type: "list", items: [
      "The link lists booked and cancelled sessions only: times and your coach's name for students, and no student names for coaches.",
      "It is shown once. **Regenerate link** replaces it and stops the old one at once; **Turn off link** removes it.",
      "Calendar apps refresh subscribed calendars on their own schedule, often every few hours.",
    ] },
  ],
  related: ["notifications", "weekly-report", "discord", "coaching"],
};
export default article;
