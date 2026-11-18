export type ContainerScenePoint = {
  x: number;
  y: number;
};

export type ContainerSceneRect = ContainerScenePoint & {
  height: number;
  width: number;
};

export type ContainerSceneItem = {
  id: string;
};

export type ContainerScenePlacement = {
  center: ContainerScenePoint;
  itemId: string | null;
  kind: "item" | "overflow";
  rotation: number;
  size: number;
};

export type ContainerSceneLayout = {
  overflowCount: number;
  placements: ContainerScenePlacement[];
  tileSize: number;
};

export type ContainerSceneLayoutOptions = {
  bounds: readonly ContainerScenePoint[];
  items: readonly ContainerSceneItem[];
  maxCardSlots?: number;
  maxOverlapRatio?: number;
  minDetailTileSize?: number;
  mode: "card" | "detail";
  preferredTileSize: number;
  seed?: string;
};

const DEFAULT_MAX_OVERLAP_RATIO = 0.2;
const DEFAULT_MIN_DETAIL_TILE_SIZE = 32;
const POSITION_JITTER_RATIO = 0.12;
const ROTATION_LIMIT = 11;
const SIZE_SEARCH_STEP = 1;
const EPSILON = 1e-7;

/**
 * Returns the image rectangle produced by object-contain inside a padded stage.
 */
export function getContainedImageRect({
  imageHeight,
  imageWidth,
  paddingFraction = 0.04,
  stageHeight,
  stageWidth,
}: {
  imageHeight: number;
  imageWidth: number;
  paddingFraction?: number;
  stageHeight: number;
  stageWidth: number;
}): ContainerSceneRect {
  assertPositiveFinite(imageWidth, "imageWidth");
  assertPositiveFinite(imageHeight, "imageHeight");
  assertPositiveFinite(stageWidth, "stageWidth");
  assertPositiveFinite(stageHeight, "stageHeight");

  if (
    !Number.isFinite(paddingFraction) ||
    paddingFraction < 0 ||
    paddingFraction >= 0.5
  ) {
    throw new RangeError("paddingFraction must be at least 0 and below 0.5");
  }

  const availableWidth = stageWidth * (1 - paddingFraction * 2);
  const availableHeight = stageHeight * (1 - paddingFraction * 2);
  const scale = Math.min(
    availableWidth / imageWidth,
    availableHeight / imageHeight,
  );
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  return {
    height,
    width,
    x: (stageWidth - width) / 2,
    y: (stageHeight - height) / 2,
  };
}

/**
 * Maps normalized image-space points into the rendered image rectangle.
 */
export function normalizedBoundsToPixels(
  bounds: readonly ContainerScenePoint[],
  imageRect: ContainerSceneRect,
): ContainerScenePoint[] {
  if (!areNormalizedClockwiseConvexBounds(bounds)) {
    throw new TypeError(
      "bounds must be four normalized clockwise convex image-space points",
    );
  }

  assertPositiveFinite(imageRect.width, "imageRect.width");
  assertPositiveFinite(imageRect.height, "imageRect.height");

  return bounds.map((point) => ({
    x: imageRect.x + point.x * imageRect.width,
    y: imageRect.y + point.y * imageRect.height,
  }));
}

/**
 * Clockwise means visual clockwise in browser coordinates, where y grows down.
 */
export function areNormalizedClockwiseConvexBounds(
  bounds: readonly ContainerScenePoint[],
): boolean {
  return (
    bounds.length === 4 &&
    bounds.every(
      ({ x, y }) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        x <= 1 &&
        y >= 0 &&
        y <= 1,
    ) &&
    signedArea(bounds) > EPSILON &&
    isStrictlyConvex(bounds)
  );
}

export function layoutContainerScene({
  bounds,
  items,
  maxCardSlots,
  maxOverlapRatio = DEFAULT_MAX_OVERLAP_RATIO,
  minDetailTileSize = DEFAULT_MIN_DETAIL_TILE_SIZE,
  mode,
  preferredTileSize,
  seed = "container-scene",
}: ContainerSceneLayoutOptions): ContainerSceneLayout {
  const effectiveMaxCardSlots = maxCardSlots ?? Math.max(1, items.length);

  validateLayoutOptions({
    bounds,
    maxCardSlots: effectiveMaxCardSlots,
    maxOverlapRatio,
    minDetailTileSize,
    preferredTileSize,
  });

  if (items.length === 0) {
    return {
      overflowCount: 0,
      placements: [],
      tileSize: preferredTileSize,
    };
  }

  if (mode === "card") {
    return layoutCard({
      bounds,
      items,
      maxOverlapRatio,
      maxSlots: effectiveMaxCardSlots,
      seed,
      tileSize: preferredTileSize,
    });
  }

  return layoutDetail({
    bounds,
    items,
    maxOverlapRatio,
    minTileSize: minDetailTileSize,
    preferredTileSize,
    seed,
  });
}

export function getRotatedSquareCorners(
  center: ContainerScenePoint,
  size: number,
  rotation: number,
): ContainerScenePoint[] {
  const halfSize = size / 2;
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  return [
    { x: -halfSize, y: -halfSize },
    { x: halfSize, y: -halfSize },
    { x: halfSize, y: halfSize },
    { x: -halfSize, y: halfSize },
  ].map(({ x, y }) => ({
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  }));
}

export function isPointInConvexPolygon(
  point: ContainerScenePoint,
  polygon: readonly ContainerScenePoint[],
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let direction = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const cross = crossProduct(start, end, point);

    if (Math.abs(cross) <= EPSILON) {
      continue;
    }

    const nextDirection = Math.sign(cross);

    if (direction !== 0 && direction !== nextDirection) {
      return false;
    }

    direction = nextDirection;
  }

  return true;
}

export function placedSquareOverlapRatio(
  first: ContainerScenePlacement,
  second: ContainerScenePlacement,
): number {
  const firstCorners = getRotatedSquareCorners(
    first.center,
    first.size,
    first.rotation,
  );
  const secondCorners = getRotatedSquareCorners(
    second.center,
    second.size,
    second.rotation,
  );
  const intersection = intersectConvexPolygons(firstCorners, secondCorners);

  return polygonArea(intersection) / Math.min(first.size ** 2, second.size ** 2);
}

type PackingOptions = {
  bounds: readonly ContainerScenePoint[];
  maxOverlapRatio: number;
  seed: string;
  slots: readonly PackingSlot[];
  tileSize: number;
};

type PackingSlot = {
  id: string;
  itemId: string | null;
  kind: "item" | "overflow";
};

function layoutCard({
  bounds,
  items,
  maxOverlapRatio,
  maxSlots,
  seed,
  tileSize,
}: {
  bounds: readonly ContainerScenePoint[];
  items: readonly ContainerSceneItem[];
  maxOverlapRatio: number;
  maxSlots: number;
  seed: string;
  tileSize: number;
}): ContainerSceneLayout {
  const maximumItemsWithoutOverflow = Math.min(items.length, maxSlots);
  const allItemsAttempt = packSlots({
    bounds,
    maxOverlapRatio,
    seed,
    slots: itemSlots(items.slice(0, maximumItemsWithoutOverflow)),
    tileSize,
  });

  if (items.length <= maxSlots && allItemsAttempt) {
    return {
      overflowCount: 0,
      placements: allItemsAttempt,
      tileSize,
    };
  }

  const maximumVisibleItems = Math.min(items.length - 1, maxSlots - 1);
  return layoutWithOverflow({
    bounds,
    items,
    maxOverlapRatio,
    maximumVisibleItems,
    seed,
    tileSize,
  });
}

function layoutDetail({
  bounds,
  items,
  maxOverlapRatio,
  minTileSize,
  preferredTileSize,
  seed,
}: {
  bounds: readonly ContainerScenePoint[];
  items: readonly ContainerSceneItem[];
  maxOverlapRatio: number;
  minTileSize: number;
  preferredTileSize: number;
  seed: string;
}): ContainerSceneLayout {
  const lowerSize = minTileSize;
  let tileSize = Math.max(preferredTileSize, lowerSize);

  while (tileSize >= lowerSize) {
    const placements = packSlots({
      bounds,
      maxOverlapRatio,
      seed,
      slots: itemSlots(items),
      tileSize,
    });

    if (placements) {
      return {
        overflowCount: 0,
        placements,
        tileSize,
      };
    }

    if (tileSize === lowerSize) {
      break;
    }

    tileSize = Math.max(lowerSize, tileSize - SIZE_SEARCH_STEP);
  }

  return layoutWithOverflow({
    bounds,
    items,
    maxOverlapRatio,
    maximumVisibleItems: items.length - 1,
    seed,
    tileSize: lowerSize,
  });
}

function layoutWithOverflow({
  bounds,
  items,
  maxOverlapRatio,
  maximumVisibleItems,
  seed,
  tileSize,
}: {
  bounds: readonly ContainerScenePoint[];
  items: readonly ContainerSceneItem[];
  maxOverlapRatio: number;
  maximumVisibleItems: number;
  seed: string;
  tileSize: number;
}): ContainerSceneLayout {
  for (
    let visibleItemCount = Math.max(0, maximumVisibleItems);
    visibleItemCount >= 0;
    visibleItemCount -= 1
  ) {
    const overflowCount = items.length - visibleItemCount;
    const placements = packSlots({
      bounds,
      maxOverlapRatio,
      seed,
      slots: [
        ...itemSlots(items.slice(0, visibleItemCount)),
        overflowSlot(overflowCount),
      ],
      tileSize,
    });

    if (placements) {
      if (overflowCount === 1) {
        const finalItem = items[visibleItemCount];

        return {
          overflowCount: 0,
          placements: placements.map((placement, index) =>
            index === placements.length - 1 && finalItem
              ? {
                  ...placement,
                  itemId: finalItem.id,
                  kind: "item",
                }
              : placement,
          ),
          tileSize,
        };
      }

      return {
        overflowCount,
        placements,
        tileSize,
      };
    }
  }

  return {
    overflowCount: items.length,
    placements: [],
    tileSize,
  };
}

function itemSlots(items: readonly ContainerSceneItem[]): PackingSlot[] {
  return items.map((item) => ({
    id: item.id,
    itemId: item.id,
    kind: "item",
  }));
}

function overflowSlot(count: number): PackingSlot {
  return {
    id: `container-scene-overflow-${count}`,
    itemId: null,
    kind: "overflow",
  };
}

function packSlots({
  bounds,
  maxOverlapRatio,
  seed,
  slots,
  tileSize,
}: PackingOptions): ContainerScenePlacement[] | null {
  const placements: ContainerScenePlacement[] = [];
  const candidates = buildCandidateCenters(bounds, tileSize);

  for (const slot of slots) {
    const slotSeed = `${seed}:${slot.id}`;
    const rotation = seededRotation(slotSeed);
    const orderedCandidates = orderCandidatesForSeed(
      candidates,
      slotSeed,
      tileSize,
    );
    let placement: ContainerScenePlacement | null = null;

    for (const center of orderedCandidates) {
      const candidate: ContainerScenePlacement = {
        center,
        itemId: slot.itemId,
        kind: slot.kind,
        rotation,
        size: tileSize,
      };

      if (
        isPlacementContained(candidate, bounds) &&
        placements.every(
          (existing) =>
            placedSquareOverlapRatio(existing, candidate) <=
            maxOverlapRatio + EPSILON,
        )
      ) {
        placement = candidate;
        break;
      }
    }

    if (!placement) {
      return null;
    }

    placements.push(placement);
  }

  return placements;
}

function isPlacementContained(
  placement: ContainerScenePlacement,
  bounds: readonly ContainerScenePoint[],
): boolean {
  return getRotatedSquareCorners(
    placement.center,
    placement.size,
    placement.rotation,
  ).every((corner) => isPointInConvexPolygon(corner, bounds));
}

function buildCandidateCenters(
  bounds: readonly ContainerScenePoint[],
  tileSize: number,
): ContainerScenePoint[] {
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

  const center = polygonCentroid(bounds);
  candidates.push(center);

  return candidates;
}

function orderCandidatesForSeed(
  candidates: readonly ContainerScenePoint[],
  seed: string,
  tileSize: number,
): ContainerScenePoint[] {
  return candidates
    .map((point, index) => ({
      index,
      point,
      rank: hashString(`${seed}:${index}`),
    }))
    .sort((first, second) => first.rank - second.rank || first.index - second.index)
    .flatMap(({ index, point }) => [
      jitterPoint(point, `${seed}:${index}`, tileSize),
      point,
    ]);
}

function jitterPoint(
  point: ContainerScenePoint,
  seed: string,
  tileSize: number,
): ContainerScenePoint {
  const amplitude = tileSize * POSITION_JITTER_RATIO;
  const xUnit = hashString(`${seed}:x`) / 0xffffffff;
  const yUnit = hashString(`${seed}:y`) / 0xffffffff;

  return {
    x: point.x + (xUnit * 2 - 1) * amplitude,
    y: point.y + (yUnit * 2 - 1) * amplitude,
  };
}

function seededRotation(seed: string): number {
  const unit = hashString(`${seed}:rotation`) / 0xffffffff;
  return (unit * 2 - 1) * ROTATION_LIMIT;
}

function hashString(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function intersectConvexPolygons(
  subject: readonly ContainerScenePoint[],
  clip: readonly ContainerScenePoint[],
): ContainerScenePoint[] {
  let output = [...subject];
  const clipDirection = Math.sign(signedArea(clip));

  for (let index = 0; index < clip.length; index += 1) {
    const clipStart = clip[index];
    const clipEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];

    if (input.length === 0) {
      break;
    }

    let previous = input.at(-1)!;

    for (const current of input) {
      const currentInside =
        crossProduct(clipStart, clipEnd, current) * clipDirection >= -EPSILON;
      const previousInside =
        crossProduct(clipStart, clipEnd, previous) * clipDirection >= -EPSILON;

      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }

      if (currentInside) {
        output.push(current);
      }

      previous = current;
    }
  }

  return output;
}

function lineIntersection(
  lineStart: ContainerScenePoint,
  lineEnd: ContainerScenePoint,
  clipStart: ContainerScenePoint,
  clipEnd: ContainerScenePoint,
): ContainerScenePoint {
  const lineX = lineEnd.x - lineStart.x;
  const lineY = lineEnd.y - lineStart.y;
  const clipX = clipEnd.x - clipStart.x;
  const clipY = clipEnd.y - clipStart.y;
  const denominator = lineX * clipY - lineY * clipX;

  if (Math.abs(denominator) <= EPSILON) {
    return lineEnd;
  }

  const offsetX = clipStart.x - lineStart.x;
  const offsetY = clipStart.y - lineStart.y;
  const distance = (offsetX * clipY - offsetY * clipX) / denominator;

  return {
    x: lineStart.x + distance * lineX,
    y: lineStart.y + distance * lineY,
  };
}

function polygonArea(points: readonly ContainerScenePoint[]): number {
  return Math.abs(signedArea(points));
}

function signedArea(points: readonly ContainerScenePoint[]): number {
  let sum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    sum += point.x * next.y - next.x * point.y;
  }

  return sum / 2;
}

function polygonCentroid(
  points: readonly ContainerScenePoint[],
): ContainerScenePoint {
  const area = signedArea(points);
  let x = 0;
  let y = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    x += (point.x + next.x) * cross;
    y += (point.y + next.y) * cross;
  }

  const denominator = area * 6;
  return {
    x: x / denominator,
    y: y / denominator,
  };
}

function isStrictlyConvex(points: readonly ContainerScenePoint[]): boolean {
  let direction = 0;

  for (let index = 0; index < points.length; index += 1) {
    const cross = crossProduct(
      points[index],
      points[(index + 1) % points.length],
      points[(index + 2) % points.length],
    );

    if (Math.abs(cross) <= EPSILON) {
      return false;
    }

    const nextDirection = Math.sign(cross);

    if (direction !== 0 && direction !== nextDirection) {
      return false;
    }

    direction = nextDirection;
  }

  return true;
}

function crossProduct(
  start: ContainerScenePoint,
  end: ContainerScenePoint,
  point: ContainerScenePoint,
): number {
  return (
    (end.x - start.x) * (point.y - start.y) -
    (end.y - start.y) * (point.x - start.x)
  );
}

function validateLayoutOptions({
  bounds,
  maxCardSlots,
  maxOverlapRatio,
  minDetailTileSize,
  preferredTileSize,
}: {
  bounds: readonly ContainerScenePoint[];
  maxCardSlots: number;
  maxOverlapRatio: number;
  minDetailTileSize: number;
  preferredTileSize: number;
}) {
  if (
    bounds.length !== 4 ||
    !bounds.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)) ||
    Math.abs(signedArea(bounds)) <= EPSILON ||
    !isStrictlyConvex(bounds)
  ) {
    throw new TypeError("bounds must be four finite convex points");
  }

  assertPositiveFinite(preferredTileSize, "preferredTileSize");
  assertPositiveFinite(minDetailTileSize, "minDetailTileSize");

  if (!Number.isInteger(maxCardSlots) || maxCardSlots < 1) {
    throw new RangeError("maxCardSlots must be a positive integer");
  }

  if (
    !Number.isFinite(maxOverlapRatio) ||
    maxOverlapRatio < 0 ||
    maxOverlapRatio > 1
  ) {
    throw new RangeError("maxOverlapRatio must be between 0 and 1");
  }
}

function assertPositiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}
