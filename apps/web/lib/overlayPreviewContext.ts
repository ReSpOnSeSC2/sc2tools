"use client";

import { createContext, useContext } from "react";

/** Sample trees may animate local fixtures, but never open live transports,
 * refetch private feeds or report demo chat as engagement. */
export const OverlayPreviewContext = createContext(false);
export const useOverlayPreview = () => useContext(OverlayPreviewContext);
