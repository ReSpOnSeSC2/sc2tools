import { PageHeader, type PageHeaderProps } from "@/components/ui/PageHeader";
import { AdminHelpLink } from "./AdminFragments";

/** Shared admin page anatomy; auth-forbidden branches render before this. */
export function AdminPageHeader({ anchor, actions, ...props }: PageHeaderProps & { anchor: string }) {
  return <PageHeader {...props} eyebrow="Admin" actions={<>{actions}<AdminHelpLink anchor={anchor} /></>} />;
}
