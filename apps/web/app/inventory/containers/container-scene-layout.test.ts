import { describe, expect, test } from "bun:test";
import {
  areNormalizedClockwiseConvexBounds,
  getContainedImageRect,
  getRotatedSquareCorners,
  isPointInConvexPolygon,
  layoutContainerScene,
  normalizedBoundsToPixels,
  placedSquareOverlapRatio,
  type ContainerScenePlacement,
  type ContainerScenePoint,
} from "./container-scene-layout";

const RECTANGLE: ContainerScenePoint[] = [
  { x: 0, y: 0 },
  { x: 500, y: 0 },
  { x: 500, y: 400 },
  { x: 0, y: 400 },
];

describe("container scene coordinate transforms", () => {
  test("object-contains landscape and portrait images within a four-percent inset", () => {
    expect(
      getContainedImageRect({
        imageHeight: 500,
        imageWidth: 1000,
        stageHeight: 400,
        stageWidth: 500,
      }),
    ).toEqual({
      height: 230,
      width: 460,
      x: 20,
      y: 85,
    });

    expect(
      getContainedImageRect({
        imageHeight: 1000,
        imageWidth: 500,
        stageHeight: 400,
        stageWidth: 500,
      }),
    ).toEqual({
      height: 368,
      width: 184,
      x: 158,
      y: 16,
    });
  });

  test("maps normalized image bounds into the actual contained image rectangle", () => {
    const pixels = normalizedBoundsToPixels(
      [
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      { height: 200, width: 400, x: 50, y: 75 },
    );

    expect(pixels).toEqual([
      { x: 90, y: 115 },
      { x: 410, y: 115 },
      { x: 370, y: 235 },
      { x: 130, y: 235 },
    ]);
  });

  test("accepts only normalized, clockwise, strictly convex quadrilaterals", () => {
    expect(
      areNormalizedClockwiseConvexBounds([
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.8, y: 0.9 },
        { x: 0.2, y: 0.9 },
      ]),
    ).toBe(true);
    expect(
      areNormalizedClockwiseConvexBounds([
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.9 },
        { x: 0.8, y: 0.9 },
        { x: 0.9, y: 0.1 },
      ]),
    ).toBe(false);
    expect(
      areNormalizedClockwiseConvexBounds([
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.4, y: 0.4 },
        { x: 0.2, y: 0.9 },
      ]),
    ).toBe(false);
    expect(
      areNormalizedClockwiseConvexBounds([
        { x: -0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.8, y: 0.9 },
        { x: 0.2, y: 0.9 },
      ]),
    ).toBe(false);
  });
});

describe("container scene packing", () => {
  test("is deterministic and gives item IDs organic positions and rotations", () => {
    const options = {
      bounds: RECTANGLE,
      items: buildItems(6),
      mode: "card" as const,
      preferredTileSize: 80,
      seed: "load-one",
    };
    const first = layoutContainerScene(options);
    const second = layoutContainerScene(options);

    expect(second).toEqual(first);
    expect(new Set(first.placements.map(({ rotation }) => rotation)).size).toBe(
      first.placements.length,
    );
    expect(
      first.placements.every(
        ({ rotation }) => rotation >= -11 && rotation <= 11,
      ),
    ).toBe(true);
    expect(
      first.placements.some(
        ({ center }) => !isOriginalGridCandidate(center, RECTANGLE, 80),
      ),
    ).toBe(true);
    expect(
      layoutContainerScene({ ...options, seed: "load-two" }).placements,
    ).not.toEqual(first.placements);
  });

  test("contains every corner and never exceeds the overlap target", () => {
    const trapezoid = [
      { x: 80, y: 30 },
      { x: 430, y: 55 },
      { x: 470, y: 370 },
      { x: 35, y: 350 },
    ];
    const result = layoutContainerScene({
      bounds: trapezoid,
      items: buildItems(6),
      mode: "card",
      preferredTileSize: 72,
    });

    expect(result.placements).toHaveLength(6);

    for (const placement of result.placements) {
      for (const corner of getRotatedSquareCorners(
        placement.center,
        placement.size,
        placement.rotation,
      )) {
        expect(isPointInConvexPolygon(corner, trapezoid)).toBe(true);
      }
    }

    expect(maximumOverlap(result.placements)).toBeLessThanOrEqual(0.2 + 1e-7);
  });

  test("fills available card geometry beyond six items before overflowing", () => {
    const result = layoutContainerScene({
      bounds: RECTANGLE,
      items: buildItems(10),
      mode: "card",
      preferredTileSize: 80,
    });

    expect(result.placements).toHaveLength(10);
    expect(result.placements.every(({ kind }) => kind === "item")).toBe(true);
    expect(result.overflowCount).toBe(0);
  });

  test("uses overflow when strict geometry cannot hold the nominal card cap", () => {
    const result = layoutContainerScene({
      bounds: [
        { x: 0, y: 0 },
        { x: 210, y: 0 },
        { x: 210, y: 105 },
        { x: 0, y: 105 },
      ],
      items: buildItems(8),
      mode: "card",
      preferredTileSize: 80,
    });

    expect(result.placements.length).toBeLessThan(6);
    expect(result.placements.at(-1)?.kind).toBe("overflow");
    expect(result.overflowCount).toBe(
      8 - result.placements.filter(({ kind }) => kind === "item").length,
    );
    expect([...new Set(result.placements.map(({ size }) => size))]).toEqual([
      80,
    ]);
  });

  test("renders the final item instead of an overflow tile for plus one", () => {
    const result = layoutContainerScene({
      bounds: [
        { x: 0, y: 0 },
        { x: 250, y: 0 },
        { x: 250, y: 160 },
        { x: 0, y: 160 },
      ],
      items: buildItems(3),
      maxCardSlots: 3,
      mode: "card",
      preferredTileSize: 80,
    });

    expect(result.placements).toHaveLength(3);
    expect(result.placements.every(({ kind }) => kind === "item")).toBe(true);
    expect(result.placements.map(({ itemId }) => itemId)).toEqual([
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(result.overflowCount).toBe(0);
  });

  test("shrinks detail tiles until every item fits, stopping above 32px", () => {
    const result = layoutContainerScene({
      bounds: RECTANGLE,
      items: buildItems(24),
      mode: "detail",
      preferredTileSize: 100,
    });

    expect(result.placements).toHaveLength(24);
    expect(result.overflowCount).toBe(0);
    expect(result.tileSize).toBeGreaterThanOrEqual(32);
    expect(result.tileSize).toBeLessThan(100);
    expect(maximumOverlap(result.placements)).toBeLessThanOrEqual(0.2 + 1e-7);
  });

  test("uses detail overflow rather than shrinking below 32px", () => {
    const result = layoutContainerScene({
      bounds: [
        { x: 0, y: 0 },
        { x: 150, y: 0 },
        { x: 150, y: 100 },
        { x: 0, y: 100 },
      ],
      items: buildItems(100),
      mode: "detail",
      preferredTileSize: 80,
    });

    expect(result.tileSize).toBe(32);
    expect(result.overflowCount).toBeGreaterThan(0);
    expect(result.placements.at(-1)?.kind).toBe("overflow");
  });

  test("honors the detail minimum when preferred size is smaller", () => {
    const result = layoutContainerScene({
      bounds: RECTANGLE,
      items: buildItems(1),
      mode: "detail",
      preferredTileSize: 12,
    });

    expect(result.tileSize).toBe(32);
    expect(result.placements[0]?.size).toBe(32);
  });

  test("scales card geometry responsively with rendered bounds", () => {
    const small = layoutContainerScene({
      bounds: RECTANGLE,
      items: buildItems(5),
      mode: "card",
      preferredTileSize: 80,
    });
    const large = layoutContainerScene({
      bounds: RECTANGLE.map(({ x, y }) => ({ x: x * 2, y: y * 2 })),
      items: buildItems(5),
      mode: "card",
      preferredTileSize: 160,
    });

    expect(large.placements).toEqual(
      small.placements.map((placement) => ({
        ...placement,
        center: {
          x: placement.center.x * 2,
          y: placement.center.y * 2,
        },
        size: placement.size * 2,
      })),
    );
  });
});

function buildItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
  }));
}

function maximumOverlap(placements: readonly ContainerScenePlacement[]) {
  let maximum = 0;

  for (let first = 0; first < placements.length; first += 1) {
    for (let second = first + 1; second < placements.length; second += 1) {
      maximum = Math.max(
        maximum,
        placedSquareOverlapRatio(placements[first], placements[second]),
      );
    }
  }

  return maximum;
}

function isOriginalGridCandidate(
  point: ContainerScenePoint,
  bounds: readonly ContainerScenePoint[],
  tileSize: number,
) {
  const minimumX = Math.min(...bounds.map(({ x }) => x));
  const maximumX = Math.max(...bounds.map(({ x }) => x));
  const minimumY = Math.min(...bounds.map(({ y }) => y));
  const maximumY = Math.max(...bounds.map(({ y }) => y));
  const spacing = tileSize * 0.82;
  const rowCount = Math.max(1, Math.ceil((maximumY - minimumY) / spacing) + 2);
  const columnCount = Math.max(
    1,
    Math.ceil((maximumX - minimumX) / spacing) + 2,
  );
  const candidates: ContainerScenePoint[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const y = minimumY + tileSize / 2 + row * spacing;
    const rowOffset = (row % 2) * spacing * 0.5;

    for (let column = -1; column < columnCount; column += 1) {
      candidates.push({
        x: minimumX + tileSize / 2 + column * spacing + rowOffset,
        y,
      });
    }
  }

  candidates.push({ x: 250, y: 200 });

  return candidates.some(
    (candidate) =>
      Math.abs(candidate.x - point.x) <= 1e-7 &&
      Math.abs(candidate.y - point.y) <= 1e-7,
  );
}
