"use client";

import { useRef, useState, type DragEvent } from "react";
import { collectDroppedFiles, droppedTreeRoots, filesOf } from "./replayDropFiles";

/** Forward a dropped folder tree once it has been walked (see `collectDroppedFiles`). */
function useFolderDrop(onDropFiles: (files: File[]) => void) {
  const [reading, setReading] = useState(false);
  const readTree = (roots: FileSystemEntry[]): void => {
    setReading(true);
    void collectDroppedFiles(roots).then((files) => {
      setReading(false);
      if (files.length > 0) onDropFiles(files);
    });
  };
  return { reading, readTree };
}

/** Drop handlers; a depth counter keeps child elements from flickering the highlight. */
export function useDropTarget(disabled: boolean, onDropFiles: (files: File[]) => void, onIntent?: () => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const { reading, readTree } = useFolderDrop(onDropFiles);
  const handlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      if (disabled) return;
      onIntent?.();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const roots = droppedTreeRoots(event.dataTransfer);
      if (roots) {
        readTree(roots);
        return;
      }
      const files = filesOf(event.dataTransfer?.files);
      if (files.length > 0) onDropFiles(files);
    },
  };
  return { dragging, reading, handlers };
}
