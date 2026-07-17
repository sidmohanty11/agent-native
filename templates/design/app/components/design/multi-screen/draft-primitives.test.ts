import { describe, expect, it } from "vitest";

import { draftPrimitiveToInsert } from "./draft-primitives";
import type {
  DraftPrimitive,
  FrameGeometry,
  ResolvedScreenMetadata,
} from "./types";

function frame(
  x: number,
  y: number,
  width: number,
  height: number,
): FrameGeometry {
  return { x, y, width, height };
}

function rectDraft(geometry: FrameGeometry): DraftPrimitive {
  return { id: "draft-rect", kind: "rectangle", geometry } as DraftPrimitive;
}

describe("draftPrimitiveToInsert draw scaling", () => {
  it("keeps a drawn rectangle the exact size it was dragged on a landscape inline frame", () => {
    // Regression: a blank inline screen carries the 1280×2560 metadata default;
    // on a landscape frame that stretched a dragged box into a tall ribbon.
    // Inline reflows to the frame, so the draw must land 1:1.
    const landscapeFrame = frame(-528, 179, 578, 398);
    const draft = rectDraft({ x: -400, y: 250, width: 200, height: 150 });
    const inlineDefault = {
      source: "inline",
      previewState: "preview",
      width: 1280,
      height: 2560,
    } as ResolvedScreenMetadata;

    const result = draftPrimitiveToInsert(draft, landscapeFrame, inlineDefault);

    expect(result.geometry.width).toBe(200);
    expect(result.geometry.height).toBe(150);
    // Positioned relative to the frame origin (no per-axis stretch).
    expect(result.geometry.x).toBe(128);
    expect(result.geometry.y).toBe(71);
  });

  it("falls back to 1:1 when an inline screen has no metadata at all", () => {
    const landscapeFrame = frame(0, 0, 800, 500);
    const draft = rectDraft({ x: 100, y: 80, width: 260, height: 180 });

    const result = draftPrimitiveToInsert(draft, landscapeFrame, undefined);

    expect(result.geometry.width).toBe(260);
    expect(result.geometry.height).toBe(180);
  });

  it("still scales a fixed-viewport (localhost) screen by its metadata", () => {
    // localhost/fusion screens render at their own viewport and are scaled to
    // fit the frame, so their draw scale must remain metadata-driven.
    const displayFrame = frame(0, 0, 640, 400);
    const draft = rectDraft({ x: 100, y: 50, width: 100, height: 50 });
    const localhost = {
      source: "localhost",
      previewState: "live",
      width: 1280,
      height: 800,
    } as ResolvedScreenMetadata;

    const result = draftPrimitiveToInsert(draft, displayFrame, localhost);

    // scaleX = 1280/640 = 2, scaleY = 800/400 = 2 (uniform) → 100×50 → 200×100.
    expect(result.geometry.width).toBe(200);
    expect(result.geometry.height).toBe(100);
  });
});
