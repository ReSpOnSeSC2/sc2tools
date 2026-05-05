/**
 * Design-system primitive exports.
 * Import as `import { Button, Card, Tabs } from "@/components/ui";`.
 *
 * The legacy Card module also exports Stat/EmptyState/Skeleton/WrBar
 * for analyzer pages — those continue to work via direct imports
 * from "@/components/ui/Card".
 */
export { Badge } from "./Badge";
export type { BadgeProps, BadgeVariant, BadgeSize } from "./Badge";
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";
export { Card } from "./Card";
export type { CardVariant } from "./Card";
export { ConfirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps } from "./ConfirmDialog";
export { DeviceFrame } from "./DeviceFrame";
export type { DeviceFrameProps, DeviceFrameVariant } from "./DeviceFrame";
export { EmptyStatePanel } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { Field } from "./Field";
export type { FieldProps } from "./Field";
export { GlowHalo } from "./GlowHalo";
export type { GlowHaloProps, GlowHaloColor, GlowHaloPosition } from "./GlowHalo";
export { Icon } from "./Icon";
export type { IconProps, IconSize } from "./Icon";
export { Input } from "./Input";
export type { InputProps, InputSize } from "./Input";
export { Modal, ModalActions } from "./Modal";
export type { ModalProps, ModalSize } from "./Modal";
export { PageHeader } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";
export { Section } from "./Section";
export type { SectionProps } from "./Section";
export { Select } from "./Select";
export type { SelectProps, SelectSize } from "./Select";
export { StatCard } from "./Stat";
export type { StatProps } from "./Stat";
export { Tabs } from "./Tabs";
export type {
  TabsProps,
  TabsTriggerProps,
  TabsContentProps,
  TabsOrientation,
} from "./Tabs";
export { ThemeToggle } from "./ThemeToggle";
export { Toggle } from "./Toggle";
export type { ToggleProps } from "./Toggle";
export { ToastProvider, useToast } from "./Toast";
export type { ToastVariant } from "./Toast";
export { SaveBar } from "./SaveBar";
export type { SaveBarProps } from "./SaveBar";
export { useDirtyForm } from "./useDirtyForm";
export type { UseDirtyFormResult } from "./useDirtyForm";
