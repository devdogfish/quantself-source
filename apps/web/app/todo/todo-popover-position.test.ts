import { expect, test } from "bun:test";
import { chooseTaskPopoverSide, positionTaskPopover, type Side } from "./todo-popover-position";

test("scrolling never hides or pushes an open task outside the viewport, including expanded content", () => {
  for (const [width, height] of [[1280, 720], [390, 844], [844, 390]]) {
    for (const side of ["left", "right", "top", "bottom"] as Side[]) {
      for (const panelHeight of [217, height * .8]) {
        let previous: ReturnType<typeof positionTaskPopover> | undefined;
        for (let top = -1800; top <= 1800; top += 8) {
          const rect = { left: 65, right: width - 3, top, bottom: top + 68 };
          const position = positionTaskPopover(rect, { left: 0, top: 0, right: width, bottom: height }, { width: 380, height: panelHeight }, side, top < height && top + 68 > 136);
          expect(position.x).toBeGreaterThanOrEqual(12);
          expect(position.y).toBeGreaterThanOrEqual(12);
          expect(position.x + position.width).toBeLessThanOrEqual(width - 12);
          expect(position.y + position.height).toBeLessThanOrEqual(height - 12);
          if (previous) expect(Math.abs(position.y - previous.y)).toBeLessThanOrEqual(8);
          if (top + 68 <= 136 || top >= height) expect(position.showArrow).toBe(false);
          previous = position;
        }
      }
    }
  }
});
test("opening side fits the source; viewport offsets and lost anchors remain bounded", () => {
  expect(chooseTaskPopoverSide({ left: 65, right: 1277, top: 600, bottom: 668 }, 1280, 720)).toBe("top");
  expect(chooseTaskPopoverSide({ left: 65, right: 1277, top: 150, bottom: 218 }, 1280, 720)).toBe("bottom");
  const p = positionTaskPopover({ left: 500, right: 600, top: 900, bottom: 950 }, { left: 10, top: 100, right: 400, bottom: 500 }, { width: 380, height: 600 }, "left", false);
  expect(p.x).toBe(22); expect(p.y).toBe(112); expect(p.showArrow).toBe(false);
});
