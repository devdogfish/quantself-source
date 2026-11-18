import { describe, expect, test } from "bun:test";
import { isPointWithinPaddedPolygon } from "./container-hover-bounds";

const BOUNDS = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 280, y: 240 },
  { x: 120, y: 240 },
];

describe("container hover bounds", () => {
  test("includes the render polygon and twenty pixel edge padding", () => {
    expect(isPointWithinPaddedPolygon({ x: 200, y: 160 }, BOUNDS, 20)).toBe(
      true,
    );
    expect(isPointWithinPaddedPolygon({ x: 200, y: 81 }, BOUNDS, 20)).toBe(
      true,
    );
    expect(isPointWithinPaddedPolygon({ x: 200, y: 79 }, BOUNDS, 20)).toBe(
      false,
    );
  });

  test("includes padding around corners", () => {
    expect(isPointWithinPaddedPolygon({ x: 88, y: 88 }, BOUNDS, 20)).toBe(
      true,
    );
    expect(isPointWithinPaddedPolygon({ x: 84, y: 84 }, BOUNDS, 20)).toBe(
      false,
    );
  });
});
