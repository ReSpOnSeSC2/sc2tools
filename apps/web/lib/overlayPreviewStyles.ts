import type { CSSProperties } from "react";
/** Shared neutral transparency preview, independent of the site's theme. */
export const CHECKERBOARD: CSSProperties = { backgroundColor: "#3d424d", backgroundImage: "repeating-conic-gradient(#4a505c 0% 25%, #3d424d 0% 50%)", backgroundSize: "18px 18px" };
export const PREVIEW_CSS = `.ov-theme-preview .widget-shell {position:relative!important;top:auto!important;left:auto!important;right:auto!important;bottom:auto!important;transform:none!important;flex-shrink:0;}`;
