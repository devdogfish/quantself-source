import {
  isPointInConvexPolygon,
  type ContainerScenePoint,
} from "./container-scene-layout";

export const CONTAINER_HOVER_PADDING_PX = 20;

export function isPointWithinPaddedPolygon(
  point: ContainerScenePoint,
  polygon: readonly ContainerScenePoint[],
  padding: number,
): boolean {
  if (isPointInConvexPolygon(point, polygon)) {
    return true;
  }

  if (padding < 0 || polygon.length < 2) {
    return false;
  }

  return polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    return distanceToSegment(point, start, end) <= padding;
  });
}

function distanceToSegment(
  point: ContainerScenePoint,
  start: ContainerScenePoint,
  end: ContainerScenePoint,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = Math.min(
    1,
    Math.max(
      0,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  const closestX = start.x + projection * deltaX;
  const closestY = start.y + projection * deltaY;

  return Math.hypot(point.x - closestX, point.y - closestY);
}
