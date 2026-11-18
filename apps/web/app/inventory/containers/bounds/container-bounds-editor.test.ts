import { describe, expect, test } from "bun:test";
import {
  boundsEqual,
  clamp,
  containerBoundsPresetUrl,
  updateMirroredBounds,
} from "./container-bounds-editor";

describe("container bounds editor geometry", () => {
  test("clamps dragged corners to normalized image space", () => {
    expect(clamp(-0.2)).toBe(0);
    expect(clamp(0.42)).toBe(0.42);
    expect(clamp(1.2)).toBe(1);
  });

  test("mirrors every corner move across the vertical center", () => {
    const bounds = [
      { x: 0.15, y: 0.2 },
      { x: 0.85, y: 0.2 },
      { x: 0.8, y: 0.7 },
      { x: 0.2, y: 0.7 },
    ] as const;

    expect(updateMirroredBounds(bounds, 0, { x: 0.12, y: 0.25 })).toEqual([
      { x: 0.12, y: 0.25 },
      { x: 0.88, y: 0.25 },
      { x: 0.8, y: 0.7 },
      { x: 0.2, y: 0.7 },
    ]);
    expect(updateMirroredBounds(bounds, 2, { x: 0.76, y: 0.74 })).toEqual([
      { x: 0.15, y: 0.2 },
      { x: 0.85, y: 0.2 },
      { x: 0.76, y: 0.74 },
      { x: 0.24, y: 0.74 },
    ]);
  });

  test("compares saved and draft bounds by coordinates", () => {
    const bounds = [
      { x: 0.15, y: 0.2 },
      { x: 0.85, y: 0.2 },
      { x: 0.8, y: 0.7 },
      { x: 0.2, y: 0.7 },
    ] as const;

    expect(boundsEqual(bounds, bounds.map((point) => ({ ...point })) as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ])).toBe(true);
    expect(
      boundsEqual(bounds, [
        { x: 0.14, y: 0.2 },
        { x: 0.86, y: 0.2 },
        { x: 0.8, y: 0.7 },
        { x: 0.2, y: 0.7 },
      ]),
    ).toBe(false);
  });

  test("writes the selected preset without dropping other URL state", () => {
    const url = containerBoundsPresetUrl(
      "https://quantself.test/inventory/containers/bounds?mode=compact",
      "39L",
    );

    expect(url.pathname).toBe("/inventory/containers/bounds");
    expect(url.searchParams.get("mode")).toBe("compact");
    expect(url.searchParams.get("preset")).toBe("39L");
  });
});
