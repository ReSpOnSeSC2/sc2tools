"use client";

import { Modal, type ModalProps } from "./Modal";

export type SheetProps = Omit<ModalProps, "placement" | "mobileLayout" | "desktopLayout"> & {
  side?: "bottom" | "right";
};

/** A modal sheet with the same focus, dismissal and scroll-lock contract. */
export function Sheet({ side = "bottom", ...props }: SheetProps) {
  return <Modal {...props} placement={side} />;
}
