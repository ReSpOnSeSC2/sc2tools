import { Section, type SectionProps } from "@/components/ui/Section";
import { GUIDE_SECTION_ANCHOR_CLASS } from "./guideUi";
import { GuideSectionCopy } from "./GuideSectionCopy";

/** Guide-only heading actions leave the generic Section primitive unchanged. */
export function GuideSection({ id, title, actions, className = "", ...props }: SectionProps) {
  return <Section {...props} id={id} title={title} className={`group/guide ${GUIDE_SECTION_ANCHOR_CLASS} ${className}`} actions={<>{actions}{id && typeof title === "string" ? <GuideSectionCopy id={id} label={title} /> : null}</>} />;
}
