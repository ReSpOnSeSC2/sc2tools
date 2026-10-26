import {
  BookOpen,
  Bug,
  Download,
  GraduationCap,
  HeartHandshake,
  Lightbulb,
  Mail,
  Search,
} from "lucide-react";
import { HELP_SUPPORT_EMAIL } from "@/lib/help/support";
import type { ReportType } from "@/lib/feedback/reportContext";
import type { NavIcon } from "./appNav";

/* ------------------------------------------------------------------
 * The Help & support menu: one list shared by the top bar's "?" menu and
 * the mobile More sheet, so the two can't drift apart. Items either link
 * somewhere or open the report form with a type preselected.
 *
 * Reports need an account (the API ties each one to its sender), so
 * signed-out visitors get the support email in their place.
 * ------------------------------------------------------------------ */

export type HelpMenuGroup = "help" | "feedback" | "support";

interface HelpMenuBase {
  key: string;
  label: string;
  icon: NavIcon;
  group: HelpMenuGroup;
}

export type HelpMenuItem =
  | (HelpMenuBase & { href: string; report?: undefined })
  | (HelpMenuBase & { report: ReportType; href?: undefined });

const HELP_ITEMS: readonly HelpMenuItem[] = [
  { key: "search-help", label: "Search help", icon: Search, href: "/help", group: "help" },
  {
    key: "stream-studio-course",
    label: "Stream Studio crash course",
    icon: GraduationCap,
    href: "/stream-studio/learn",
    group: "help",
  },
  {
    key: "desktop-app",
    label: "Download / update the desktop app",
    icon: Download,
    href: "/download",
    group: "help",
  },
  { key: "appearance", label: "Accessibility & appearance", icon: BookOpen, href: "/help/appearance", group: "help" },
  { key: "accessibility", label: "Accessibility statement", icon: BookOpen, href: "/legal/accessibility", group: "help" },
];

const REPORT_ITEMS: readonly HelpMenuItem[] = [
  { key: "report-problem", label: "Report a problem", icon: Bug, report: "problem", group: "feedback" },
  { key: "suggest-feature", label: "Suggest a feature", icon: Lightbulb, report: "idea", group: "feedback" },
];

const EMAIL_ITEM: HelpMenuItem = {
  key: "email-support",
  label: "Email support",
  icon: Mail,
  href: `mailto:${HELP_SUPPORT_EMAIL}`,
  group: "feedback",
};

const TRAILING_ITEMS: readonly HelpMenuItem[] = [
  { key: "how-reports-work", label: "How reports work", icon: BookOpen, href: "/help/report-a-problem", group: "feedback" },
  { key: "donate", label: "Support SC2 Tools", icon: HeartHandshake, href: "/donate", group: "support" },
];

/**
 * The menu's items in display order, grouped help → feedback → support.
 *
 * Example: `helpMenuItems(false).some((item) => item.report)` → false.
 */
export function helpMenuItems(signedIn: boolean): readonly HelpMenuItem[] {
  return [...HELP_ITEMS, ...(signedIn ? REPORT_ITEMS : [EMAIL_ITEM]), ...TRAILING_ITEMS];
}
