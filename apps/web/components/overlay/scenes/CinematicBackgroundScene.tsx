import type { CSSProperties } from "react";
import {
  getStreamBackground,
  type StreamBackgroundId,
} from "@/lib/streamBackgrounds";

const CANVAS_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100vw",
  height: "100vh",
  overflow: "hidden",
  pointerEvents: "none",
};

const PICTURE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "block",
  width: "100%",
  height: "100%",
};

/**
 * One static, full-canvas virtual set for an OBS Browser Source.
 *
 * It deliberately renders no title, logo, timer or motion. Camera, chat and
 * game-capture sources can sit above this layer without fighting baked-in UI,
 * while ``object-fit: cover`` keeps every canvas ratio edge-to-edge. OBS at 4K
 * receives the matching 3840px export through the responsive image candidates.
 */
export function CinematicBackgroundScene({
  backgroundId,
}: {
  backgroundId: StreamBackgroundId;
}) {
  const background = getStreamBackground(backgroundId);

  return (
    <div
      aria-hidden="true"
      data-background-id={background.id}
      data-scene-kind="cinematic-background"
      style={{ ...CANVAS_STYLE, backgroundColor: background.canvasColor }}
    >
      <picture style={PICTURE_STYLE}>
        <source
          media="(min-width: 2560px)"
          srcSet={`${background.src4k} 3840w`}
        />
        <img
          src={background.src1080}
          srcSet={`${background.src1080} 1920w, ${background.src4k} 3840w`}
          sizes="100vw"
          alt=""
          width={1920}
          height={1080}
          decoding="async"
          fetchPriority="high"
          draggable={false}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: background.objectPosition,
          }}
        />
      </picture>

      {/* A restrained broadcast grade keeps the canvas cinematic without
          hiding the art or introducing animated compositor work. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.04) 0%, transparent 42%, rgba(0,0,0,0.16) 100%)",
          boxShadow: "inset 0 0 11vw rgba(0,0,0,0.22)",
        }}
      />
    </div>
  );
}
