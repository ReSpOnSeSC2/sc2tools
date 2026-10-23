import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminShell } from "./components/AdminShell";

// Admin pages are client components; they share this tab title.
export const metadata: Metadata = {
  title: "Dashboard · Admin",
  robots: { index: false },
};

/**
 * /admin layout — wraps every admin page in the responsive shell.
 *
 * The shell renders the sidebar (desktop) / drawer-style nav (mobile)
 * and the content frame. Page-level files plug into the shell via its
 * children prop. Auth gating happens server-side at the API layer
 * (``isAdmin`` middleware on every ``/v1/admin/*`` endpoint); this
 * file focuses on chrome.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
