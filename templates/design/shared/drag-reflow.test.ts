import { describe, expect, it } from "vitest";

import {
  computeInsertOffsets,
  computeReorderOffsets,
  computeVacateOffsets,
  type DragTargetCandidate,
  type HysteresisState,
  isContainerTooSmallForDrag,
  isSimplePackedContainer,
  mainAxisForDirection,
  type PackedContainerInfo,
  resolveTargetHysteresis,
} from "./drag-reflow";

// ---------------------------------------------------------------------------
// Hysteresis
// ---------------------------------------------------------------------------

function candidate(
  over: Partial<DragTargetCandidate> & Pick<DragTargetCandidate, "key">,
): DragTargetCandidate {
  return {
    pointerMain: 0,
    boundaryMain: null,
    containerPenetrationPx: Infinity,
    isLeave: false,
    ...over,
  };
}

describe("resolveTargetHysteresis", () => {
  it("clears instantly when the candidate is null", () => {
    const prev: HysteresisState = {
      key: { containerKey: "A", index: 0 },
      committedAt: 0,
    };
    const res = resolveTargetHysteresis(prev, candidate({ key: null }), 5);
    expect(res.key).toBeNull();
    expect(res.changed).toBe(true);
    expect(res.state).toBeNull();
  });

  it("reports no change when clearing from an already-empty state", () => {
    const res = resolveTargetHysteresis(null, candidate({ key: null }), 5);
    expect(res.key).toBeNull();
    expect(res.changed).toBe(false);
  });

  it("accepts the first target immediately (no lag before the guide appears)", () => {
    const res = resolveTargetHysteresis(
      null,
      candidate({ key: { containerKey: "A", index: 2 } }),
      100,
    );
    expect(res.key).toEqual({ containerKey: "A", index: 2 });
    expect(res.changed).toBe(true);
    expect(res.state).toEqual({
      key: { containerKey: "A", index: 2 },
      committedAt: 100,
    });
  });

  it("holds an unchanged target and preserves the original commit time", () => {
    const prev: HysteresisState = {
      key: { containerKey: "A", index: 1 },
      committedAt: 40,
    };
    const res = resolveTargetHysteresis(
      prev,
      candidate({ key: { containerKey: "A", index: 1 } }),
      999,
    );
    expect(res.changed).toBe(false);
    expect(res.state).toBe(prev); // committedAt not refreshed
  });

  describe("index change within the same container", () => {
    const prev: HysteresisState = {
      key: { containerKey: "A", index: 0 },
      committedAt: 0,
    };

    it("rejects while the pointer is within the boundary deadband and dwell not met", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "A", index: 1 },
          boundaryMain: 100,
          pointerMain: 105,
        }),
        10, // elapsed 10ms < 60ms
      );
      expect(res.changed).toBe(false);
      expect(res.key).toEqual({ containerKey: "A", index: 0 });
    });

    it("accepts once the pointer crosses the boundary by >= 8px", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "A", index: 1 },
          boundaryMain: 100,
          pointerMain: 92,
        }),
        10,
      );
      expect(res.changed).toBe(true);
      expect(res.key).toEqual({ containerKey: "A", index: 1 });
    });

    it("accepts on dwell even when still inside the deadband", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "A", index: 1 },
          boundaryMain: 100,
          pointerMain: 101,
        }),
        60, // elapsed 60ms >= 60ms
      );
      expect(res.changed).toBe(true);
    });

    it("falls back to dwell-only when there is no boundary (empty-container inside)", () => {
      const early = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "A", index: 1 },
          boundaryMain: null,
          pointerMain: 5000,
        }),
        30,
      );
      expect(early.changed).toBe(false);
      const late = resolveTargetHysteresis(
        prev,
        candidate({ key: { containerKey: "A", index: 1 }, boundaryMain: null }),
        60,
      );
      expect(late.changed).toBe(true);
    });
  });

  describe("container change", () => {
    const prev: HysteresisState = {
      key: { containerKey: "A", index: 3 },
      committedAt: 0,
    };

    it("reverses instantly when leaving to an ancestor", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "PARENT", index: 1 },
          isLeave: true,
          containerPenetrationPx: 0,
        }),
        1,
      );
      expect(res.changed).toBe(true);
      expect(res.key).toEqual({ containerKey: "PARENT", index: 1 });
    });

    it("rejects a shallow entry into a new container before penetration/dwell", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "B", index: 0 },
          containerPenetrationPx: 5,
        }),
        10,
      );
      expect(res.changed).toBe(false);
      expect(res.key).toEqual({ containerKey: "A", index: 3 });
    });

    it("accepts once penetration >= 10px", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "B", index: 0 },
          containerPenetrationPx: 12,
        }),
        10,
      );
      expect(res.changed).toBe(true);
      expect(res.key).toEqual({ containerKey: "B", index: 0 });
    });

    it("accepts a shallow entry on dwell", () => {
      const res = resolveTargetHysteresis(
        prev,
        candidate({
          key: { containerKey: "B", index: 0 },
          containerPenetrationPx: 5,
        }),
        80,
      );
      expect(res.changed).toBe(true);
    });
  });

  it("honors custom thresholds", () => {
    const prev: HysteresisState = {
      key: { containerKey: "A", index: 0 },
      committedAt: 0,
    };
    const res = resolveTargetHysteresis(
      prev,
      candidate({
        key: { containerKey: "A", index: 1 },
        boundaryMain: 100,
        pointerMain: 97,
      }),
      5,
      { indexBoundaryPx: 2 }, // |97-100|=3 >= 2
    );
    expect(res.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Size guard
// ---------------------------------------------------------------------------

describe("isContainerTooSmallForDrag", () => {
  it("allows a container that fits the dragged element", () => {
    expect(
      isContainerTooSmallForDrag(
        { width: 100, height: 40 },
        { width: 50, height: 20 },
      ),
    ).toBe(false);
  });

  it("rejects a container narrower than the dragged element", () => {
    expect(
      isContainerTooSmallForDrag(
        { width: 30, height: 40 },
        { width: 50, height: 20 },
      ),
    ).toBe(true);
  });

  it("rejects a container shorter than the dragged element", () => {
    expect(
      isContainerTooSmallForDrag(
        { width: 100, height: 10 },
        { width: 50, height: 20 },
      ),
    ).toBe(true);
  });

  it("is bypassed by the ⌘ override", () => {
    expect(
      isContainerTooSmallForDrag(
        { width: 5, height: 5 },
        { width: 500, height: 500 },
        { bypass: true },
      ),
    ).toBe(false);
  });

  it("does not reject on an axis the container hugs (it would grow to fit)", () => {
    // Container is too narrow, but it hugs its width → allowed.
    expect(
      isContainerTooSmallForDrag(
        { width: 30, height: 40 },
        { width: 50, height: 20 },
        { hugAxis: "width" },
      ),
    ).toBe(false);
    // …still rejected if it is also too short on the non-hug axis.
    expect(
      isContainerTooSmallForDrag(
        { width: 30, height: 10 },
        { width: 50, height: 20 },
        { hugAxis: "width" },
      ),
    ).toBe(true);
  });

  it("respects tolerance slack", () => {
    expect(
      isContainerTooSmallForDrag(
        { width: 48, height: 40 },
        { width: 50, height: 20 },
        { tolerancePx: 4 },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Packed-container detection
// ---------------------------------------------------------------------------

function packed(over: Partial<PackedContainerInfo> = {}): PackedContainerInfo {
  return {
    display: "flex",
    flexDirection: "row",
    flexWrap: "nowrap",
    justifyContent: "flex-start",
    gap: 8,
    hasFlexGrowChild: false,
    ...over,
  };
}

describe("isSimplePackedContainer", () => {
  it("accepts a start-aligned, nowrap, fixed-gap flex row/column", () => {
    expect(isSimplePackedContainer(packed())).toBe(true);
    expect(isSimplePackedContainer(packed({ flexDirection: "column" }))).toBe(
      true,
    );
    expect(isSimplePackedContainer(packed({ display: "inline-flex" }))).toBe(
      true,
    );
    expect(isSimplePackedContainer(packed({ justifyContent: "start" }))).toBe(
      true,
    );
    expect(isSimplePackedContainer(packed({ justifyContent: "normal" }))).toBe(
      true,
    );
    expect(isSimplePackedContainer(packed({ justifyContent: "" }))).toBe(true);
    expect(isSimplePackedContainer(packed({ gap: 0 }))).toBe(true);
  });

  it("rejects non-flex containers", () => {
    expect(isSimplePackedContainer(packed({ display: "block" }))).toBe(false);
    expect(isSimplePackedContainer(packed({ display: "grid" }))).toBe(false);
  });

  it("rejects distributed justification (the constant-shift model would lie)", () => {
    for (const jc of [
      "space-between",
      "space-around",
      "space-evenly",
      "center",
      "flex-end",
      "end",
    ]) {
      expect(isSimplePackedContainer(packed({ justifyContent: jc }))).toBe(
        false,
      );
    }
  });

  it("rejects wrap", () => {
    expect(isSimplePackedContainer(packed({ flexWrap: "wrap" }))).toBe(false);
    expect(isSimplePackedContainer(packed({ flexWrap: "wrap-reverse" }))).toBe(
      false,
    );
  });

  it("rejects reverse directions (offset signs would invert)", () => {
    expect(
      isSimplePackedContainer(packed({ flexDirection: "row-reverse" })),
    ).toBe(false);
    expect(
      isSimplePackedContainer(packed({ flexDirection: "column-reverse" })),
    ).toBe(false);
  });

  it("rejects a negative or non-finite gap", () => {
    expect(isSimplePackedContainer(packed({ gap: -4 }))).toBe(false);
    expect(isSimplePackedContainer(packed({ gap: NaN }))).toBe(false);
  });

  it("rejects a container with a flex-grow child (it resizes, not translates)", () => {
    expect(isSimplePackedContainer(packed({ hasFlexGrowChild: true }))).toBe(
      false,
    );
  });
});

describe("mainAxisForDirection", () => {
  it("maps row → x and column → y", () => {
    expect(mainAxisForDirection("row")).toBe("x");
    expect(mainAxisForDirection("row-reverse")).toBe("x");
    expect(mainAxisForDirection("column")).toBe("y");
    expect(mainAxisForDirection("column-reverse")).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// Reflow offsets
// ---------------------------------------------------------------------------

describe("computeReorderOffsets", () => {
  const slotMain = 60;

  it("shifts intermediate siblings toward the start when moving later", () => {
    // 5 items, drag item 1 to before item 4.
    const offsets = computeReorderOffsets({
      count: 5,
      originIndex: 1,
      targetSlot: 4,
      slotMain,
    });
    expect(offsets).toEqual([0, 0, -60, -60, 0]);
  });

  it("shifts intermediate siblings toward the end when moving earlier", () => {
    // 5 items, drag item 3 to before item 1.
    const offsets = computeReorderOffsets({
      count: 5,
      originIndex: 3,
      targetSlot: 1,
      slotMain,
    });
    expect(offsets).toEqual([0, 60, 60, 0, 0]);
  });

  it("moves nothing when dropped back into the same slot", () => {
    expect(
      computeReorderOffsets({
        count: 5,
        originIndex: 2,
        targetSlot: 2,
        slotMain,
      }),
    ).toEqual([0, 0, 0, 0, 0]);
    // targetSlot === originIndex + 1 is also a no-op (before the very next sibling).
    expect(
      computeReorderOffsets({
        count: 5,
        originIndex: 2,
        targetSlot: 3,
        slotMain,
      }),
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it("moves a single sibling when swapping adjacent neighbors", () => {
    // drag item 0 to before item 2 → only item 1 shifts start-ward.
    expect(
      computeReorderOffsets({
        count: 3,
        originIndex: 0,
        targetSlot: 2,
        slotMain,
      }),
    ).toEqual([0, -60, 0]);
  });

  it("moves to the very end", () => {
    // drag item 0 to end (before slot count) → items 1 and 2 shift start-ward.
    expect(
      computeReorderOffsets({
        count: 3,
        originIndex: 0,
        targetSlot: 3,
        slotMain,
      }),
    ).toEqual([0, -60, -60]);
  });
});

describe("computeVacateOffsets", () => {
  it("closes the gap by shifting following siblings toward the start", () => {
    expect(
      computeVacateOffsets({ count: 5, originIndex: 1, slotMain: 60 }),
    ).toEqual([0, 0, -60, -60, -60]);
  });

  it("moves nothing when the dragged item is last", () => {
    expect(
      computeVacateOffsets({ count: 3, originIndex: 2, slotMain: 60 }),
    ).toEqual([0, 0, 0]);
  });
});

describe("computeInsertOffsets", () => {
  it("opens a slot by shifting the insertion point and everything after it end-ward", () => {
    expect(
      computeInsertOffsets({ count: 4, targetSlot: 2, slotMain: 60 }),
    ).toEqual([0, 0, 60, 60]);
  });

  it("opens a leading slot (insert at front) by shifting all children", () => {
    expect(
      computeInsertOffsets({ count: 3, targetSlot: 0, slotMain: 60 }),
    ).toEqual([60, 60, 60]);
  });

  it("opens a trailing slot (append) with no sibling movement", () => {
    expect(
      computeInsertOffsets({ count: 3, targetSlot: 3, slotMain: 60 }),
    ).toEqual([0, 0, 0]);
  });
});
