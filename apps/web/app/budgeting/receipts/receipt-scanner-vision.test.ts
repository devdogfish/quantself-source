import { expect, test } from "bun:test";
import { createReceiptCaptureGate, findReceiptFrame } from "./receipt-scanner-vision";

const width = 96;
const height = 144;

function sample(left: number, top: number, right: number, bottom: number, printed = true) {
  const pixels = new Uint8Array(width * height).fill(48);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const ink = printed && x >= left + 12 && x < right - 12 && y > top + 10 && y < bottom - 10 && y % 7 < 2;
      pixels[y * width + x] = ink ? 40 : 224;
    }
  }
  return { width, height, pixels };
}

test("detects the bounds of a framed printed receipt and rejects blank or clipped frames", () => {
  expect(findReceiptFrame(sample(23, 19, 73, 122))).toEqual({
    left: 23 / width,
    top: 19 / height,
    right: 73 / width,
    bottom: 122 / height,
  });
  expect(findReceiptFrame(sample(23, 19, 73, 122, false))).toBeNull();
  expect(findReceiptFrame(sample(23, 19, 73, height))).toBeNull();
  expect(findReceiptFrame({ width, height, pixels: new Uint8Array(width * height).fill(215) })).toBeNull();
});

test("auto-capture requires a steady frame and re-arms only after the receipt leaves", () => {
  const frame = findReceiptFrame(sample(23, 19, 73, 122))!;
  const gate = createReceiptCaptureGate();
  for (let i = 0; i < 10; i++) expect(gate.observe(frame, 10).ready).toBe(false);
  for (let i = 0; i < 4; i++) expect(gate.observe(frame, 0).ready).toBe(false);
  expect(gate.observe(frame, 0).ready).toBe(true);
  gate.captured();
  for (let i = 0; i < 10; i++) expect(gate.observe(frame, 0)).toEqual({ ready: false, waitingForRemoval: true });
  for (let i = 0; i < 2; i++) expect(gate.observe(null, 0).waitingForRemoval).toBe(true);
  expect(gate.observe(null, 0).waitingForRemoval).toBe(false);
  for (let i = 0; i < 5; i++) expect(gate.observe(frame, 0).ready).toBe(false);
  expect(gate.observe(frame, 0).ready).toBe(true);
});
